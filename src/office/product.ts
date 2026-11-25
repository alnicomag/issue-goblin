/**
 * 製品リポジトリ直下の `factory.yml` の取得と検証。
 * 段階0では、検証した内容を `repos.factory_yml` に保存するところまでを行う。
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MAX_DOCKERFILE_BYTES } from "../launcher/request.ts";
import { type Clock, isoNow } from "./clock.ts";
import { formatZodError } from "./config.ts";
import type { Db } from "./db.ts";
import { insertEvent } from "./events.ts";
import type { GitHubApi } from "./github.ts";
import type { Logger } from "./log.ts";
import { globPatternError, type PathRules } from "./paths.ts";

export const FACTORY_YML_PATH = "factory.yml";

const Command = z.string().min(1);

/**
 * `paths` のパターン。publish の照合と同じ関数で、読めるかを確かめる。
 * 読めないパターンを publish の時点まで持ち越さず、着手の前に不正として扱うためである。
 * 空のパターンも、ここで読めないものとして落ちる。
 */
const PathPattern = z.string().superRefine((pattern, context) => {
  const message = globPatternError(pattern);
  if (message !== null) context.addIssue({ code: "custom", message });
});

/**
 * `worker.dockerfile` のパス。リポジトリの直下からの相対パスで書く。
 *
 * 使えるのは、英数字と `.`、`_`、`-`、区切りの `/` だけにする。リポジトリの外を指せず、
 * パスのパターン(`paths.protected`)としても、そのパス1つだけに当たる(`*` や `?` を含まない)。
 */
const DockerfilePath = z.string().superRefine((value, context) => {
  const fail = (reason: string) =>
    context.addIssue({
      code: "custom",
      message: `Dockerfile の場所を読めません: ${JSON.stringify(value)}(${reason})`,
    });
  if (value === "") return fail("空です");
  if (value.length > 255) return fail("長すぎます");
  if (value.startsWith("/")) {
    return fail("リポジトリの直下からの相対パスで書いてください");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    return fail("使えるのは、英数字と . _ - / だけです");
  }
  for (const segment of value.split("/")) {
    if (segment === "") return fail("区切りが続いているか、末尾にあります");
    if (segment === "." || segment === "..") {
      return fail(". と .. は使えません");
    }
  }
});

export const FactoryYmlSchema = z.strictObject({
  version: z.literal(1),
  level: z.enum(["A", "B", "C"]),
  commands: z.strictObject({
    setup: Command,
    test: Command,
    lint: Command,
  }),
  verify: z
    .strictObject({ unverified: z.array(z.string().min(1)).default([]) })
    .default({ unverified: [] }),
  paths: z
    .strictObject({
      protected: z.array(PathPattern).default([]),
      forbidden: z.array(PathPattern).default([]),
    })
    .default({ protected: [], forbidden: [] }),
  limits: z
    .strictObject({
      max_parallel: z.number().int().min(1).default(1),
      max_attempts: z.number().int().min(1).default(3),
    })
    .default({ max_parallel: 1, max_attempts: 3 }),
  /**
   * ワーカーの環境。`dockerfile` は、ワーカーのイメージに製品のツールを足す定義の場所。
   * 省略すると、ファクトリー側の設定のイメージをそのまま使う。
   */
  worker: z.strictObject({ dockerfile: DockerfilePath.optional() }).optional(),
  issues: z.strictObject({
    allowed_authors: z.array(z.string().min(1)),
  }),
});

export type FactoryYml = z.infer<typeof FactoryYmlSchema>;

/** 製品の Dockerfile の場所(`worker.dockerfile`)。書いていなければ null。 */
export function workerDockerfilePath(factoryYml: FactoryYml): string | null {
  return factoryYml.worker?.dockerfile ?? null;
}

/**
 * 変更されたパスに照らす規則。`paths` に、`worker.dockerfile` のパスを保護対象として足したもの。
 *
 * Dockerfile はワーカーの環境を決めるので、製品が `paths.protected` に書いていなくても、
 * 変更に人間の承認を求める。
 */
export function pathRulesOf(factoryYml: FactoryYml): PathRules {
  const dockerfile = workerDockerfilePath(factoryYml);
  const { forbidden } = factoryYml.paths;
  if (dockerfile === null || factoryYml.paths.protected.includes(dockerfile)) {
    return { forbidden, protected: factoryYml.paths.protected };
  }
  return { forbidden, protected: [...factoryYml.paths.protected, dockerfile] };
}

export type FactoryYmlParseResult =
  | { readonly ok: true; readonly value: FactoryYml }
  | { readonly ok: false; readonly errors: string };

/** `factory.yml` の文字列を検証する。純粋関数。 */
export function parseFactoryYml(text: string): FactoryYmlParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: `YAMLとして読めません: ${detail}` };
  }
  const result = FactoryYmlSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
}

export type FactoryYmlSyncOutcome =
  | "unchanged"
  | "updated"
  | "invalid"
  | "missing";

/**
 * 1つのリポジトリの `factory.yml` を取得し、検証して保存する。
 *
 * - 内容(sha)が変わっていなければ何もしない。
 * - 不正なら `repo.config_invalid`、ファイルがなければ `repo.config_missing` を記録する。
 *   同じ状態が続いている間は、イベントを重ねて記録しない。
 */
export async function syncFactoryYml(deps: {
  db: Db;
  api: GitHubApi;
  repo: string;
  clock: Clock;
  logger: Logger;
}): Promise<FactoryYmlSyncOutcome> {
  const { db, api, repo, clock, logger } = deps;
  const stored = db
    .prepare("SELECT factory_yml_sha AS sha FROM repos WHERE repo = ?")
    .get(repo) as { sha: string | null } | undefined;
  if (stored === undefined) {
    throw new Error(`repos に ${repo} の行がありません`);
  }

  const file = await api.getFile(repo, FACTORY_YML_PATH, stored.sha);
  if (file.status === "unchanged") return "unchanged";

  const save = db.prepare(
    "UPDATE repos SET factory_yml = ?, factory_yml_sha = ? WHERE repo = ?",
  );

  if (file.status === "missing") {
    const alreadyRecorded =
      stored.sha === null &&
      lastConfigEventType(db, repo) === "repo.config_missing";
    if (alreadyRecorded) return "missing";
    db.transaction(() => {
      save.run(null, null, repo);
      insertEvent(db, {
        type: "repo.config_missing",
        repo,
        issueNumber: null,
        payload: { path: FACTORY_YML_PATH },
        createdAt: isoNow(clock),
      });
    })();
    logger.warn("product.config_missing", { repo, path: FACTORY_YML_PATH });
    return "missing";
  }

  if (file.sha === stored.sha) return "unchanged";

  const parsed = parseFactoryYml(file.content);
  if (!parsed.ok) {
    db.transaction(() => {
      save.run(null, file.sha, repo);
      insertEvent(db, {
        type: "repo.config_invalid",
        repo,
        issueNumber: null,
        payload: {
          path: FACTORY_YML_PATH,
          sha: file.sha,
          errors: parsed.errors,
        },
        createdAt: isoNow(clock),
      });
    })();
    logger.warn("product.config_invalid", {
      repo,
      path: FACTORY_YML_PATH,
      errors: parsed.errors,
    });
    return "invalid";
  }

  save.run(JSON.stringify(parsed.value), file.sha, repo);
  logger.info("product.config_updated", { repo, sha: file.sha });
  return "updated";
}

function lastConfigEventType(db: Db, repo: string): string | null {
  const row = db
    .prepare(
      `SELECT type FROM events
       WHERE repo = ? AND type IN ('repo.config_missing', 'repo.config_invalid')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repo) as { type: string } | undefined;
  return row?.type ?? null;
}

/**
 * 保存済みの `factory.yml`(事務局が同期して検証したもの)を読む。
 *
 * 作業場所にあるファイルではなく、こちらを使う。作業場所のファイルはワーカーが書き換えられるからである。
 * 未取得の場合と、不正で保存されていない場合は、原因の分かるメッセージで失敗する。
 * 保存してある内容も、使う前に検証し直す(`paths` のパターンの書き方を含む)。
 */
export function readStoredFactoryYml(db: Db, repo: string): FactoryYml {
  const row = db
    .prepare(
      "SELECT factory_yml AS content, factory_yml_sha AS sha FROM repos WHERE repo = ?",
    )
    .get(repo) as { content: string | null; sha: string | null } | undefined;
  if (row === undefined) {
    throw new Error(
      `リポジトリ ${repo} は未取得です(repos に行がありません。同期が済んでいません)`,
    );
  }
  if (row.content === null) {
    throw new Error(
      row.sha === null
        ? `リポジトリ ${repo} の ${FACTORY_YML_PATH} は未取得です(まだ同期していないか、ファイルがありません)`
        : `リポジトリ ${repo} の ${FACTORY_YML_PATH} が不正です(検証に通らなかったので、保存されていません。sha: ${row.sha})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.content);
  } catch {
    throw new Error(
      `リポジトリ ${repo} の ${FACTORY_YML_PATH} の保存内容をJSONとして読めません`,
    );
  }
  const result = FactoryYmlSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `リポジトリ ${repo} の ${FACTORY_YML_PATH} の保存内容が不正です:\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

/** 保存してある、製品の Dockerfile。 */
export interface StoredWorkerDockerfile {
  /** `factory.yml` の `worker.dockerfile`。 */
  readonly path: string;
  /** 既定ブランチから取得した内容の sha。 */
  readonly sha: string;
  /** 本文。 */
  readonly content: string;
}

const DockerfileRowSchema = z.object({
  factory_yml: z.string().nullable(),
  content: z.string().nullable(),
  sha: z.string().nullable(),
  path: z.string().nullable(),
});

function readDockerfileRow(db: Db, repo: string) {
  const row = db
    .prepare(
      `SELECT factory_yml,
              worker_dockerfile AS content,
              worker_dockerfile_sha AS sha,
              worker_dockerfile_path AS path
       FROM repos WHERE repo = ?`,
    )
    .get(repo);
  if (row === undefined) return null;
  return DockerfileRowSchema.parse(row);
}

/** 保存してある `factory.yml` が指す Dockerfile の場所。読めなければ null。 */
function wantedDockerfilePath(factoryYml: string | null): string | null {
  if (factoryYml === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(factoryYml);
  } catch {
    return null;
  }
  const parsed = FactoryYmlSchema.safeParse(raw);
  return parsed.success ? workerDockerfilePath(parsed.data) : null;
}

export type WorkerDockerfileSyncOutcome =
  | "none"
  | "unchanged"
  | "updated"
  | "missing"
  | "too_large";

/**
 * `factory.yml` の `worker.dockerfile` が指すファイルを、既定ブランチから取得して保存する。
 * `syncFactoryYml` の後に呼ぶ。
 *
 * - `factory.yml` に書かれていなければ(未取得、不正を含む)、保存してあるものを消す。
 * - ファイルがないか、大きすぎれば、本文を消す。この製品のイメージはビルドできないので、
 *   依頼は起動係に送る前に失敗する(`readStoredWorkerDockerfile`)。
 * - 同じ状態が続いている間は、ログを重ねて出さない。
 */
export async function syncWorkerDockerfile(deps: {
  db: Db;
  api: GitHubApi;
  repo: string;
  logger: Logger;
}): Promise<WorkerDockerfileSyncOutcome> {
  const { db, api, repo, logger } = deps;
  const row = readDockerfileRow(db, repo);
  if (row === null) {
    throw new Error(`repos に ${repo} の行がありません`);
  }
  const save = db.prepare(
    `UPDATE repos
     SET worker_dockerfile = ?, worker_dockerfile_sha = ?, worker_dockerfile_path = ?
     WHERE repo = ?`,
  );

  const wanted = wantedDockerfilePath(row.factory_yml);
  if (wanted === null) {
    if (row.content !== null || row.sha !== null || row.path !== null) {
      save.run(null, null, null, repo);
      logger.info("product.dockerfile_removed", { repo, path: row.path });
    }
    return "none";
  }

  const samePath = row.path === wanted;
  const file = await api.getFile(repo, wanted, samePath ? row.sha : null);
  if (file.status === "unchanged") return "unchanged";

  if (file.status === "missing") {
    if (!samePath || row.content !== null || row.sha !== null) {
      save.run(null, null, wanted, repo);
      logger.warn("product.dockerfile_missing", { repo, path: wanted });
    }
    return "missing";
  }

  const bytes = Buffer.byteLength(file.content);
  if (bytes > MAX_DOCKERFILE_BYTES) {
    if (!samePath || row.content !== null || row.sha !== file.sha) {
      save.run(null, file.sha, wanted, repo);
      logger.warn("product.dockerfile_too_large", {
        repo,
        path: wanted,
        sha: file.sha,
        bytes,
        max_bytes: MAX_DOCKERFILE_BYTES,
      });
    }
    return "too_large";
  }

  if (samePath && row.sha === file.sha && row.content === file.content) {
    return "unchanged";
  }
  save.run(file.content, file.sha, wanted, repo);
  logger.info("product.dockerfile_updated", {
    repo,
    path: wanted,
    sha: file.sha,
  });
  return "updated";
}

/**
 * 保存してある製品の Dockerfile(事務局が既定ブランチから取得したもの)を読む。
 *
 * `factory.yml` に `worker.dockerfile` がなければ null を返す(設定のイメージをそのまま使う)。
 * 書かれているのに本文がない場合(未取得、ファイルがない、大きすぎる、パスが変わった直後)は、
 * 原因の分かるメッセージで失敗する。設定のイメージに黙って切り替えない。
 */
export function readStoredWorkerDockerfile(
  db: Db,
  repo: string,
): StoredWorkerDockerfile | null {
  const wanted = workerDockerfilePath(readStoredFactoryYml(db, repo));
  if (wanted === null) return null;
  const row = readDockerfileRow(db, repo);
  if (
    row === null ||
    row.path !== wanted ||
    row.content === null ||
    row.sha === null
  ) {
    throw new Error(
      `リポジトリ ${repo} の Dockerfile(${FACTORY_YML_PATH} の worker.dockerfile: ${wanted})を使えません(既定ブランチにファイルがないか、${MAX_DOCKERFILE_BYTES} バイトを超えているか、まだ取得していません)`,
    );
  }
  return { path: wanted, sha: row.sha, content: row.content };
}

/**
 * 保存してある製品の Dockerfile の sha。着手前の確認の条件に使う。
 * `worker.dockerfile` がないか、本文を使えなければ null。失敗しない。
 */
export function storedWorkerDockerfileSha(db: Db, repo: string): string | null {
  const row = readDockerfileRow(db, repo);
  if (row === null || row.content === null) return null;
  return row.path === wantedDockerfilePath(row.factory_yml) ? row.sha : null;
}
