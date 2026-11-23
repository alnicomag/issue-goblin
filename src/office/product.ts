/**
 * 製品リポジトリ直下の `factory.yml` の取得と検証。
 * 段階0では、検証した内容を `repos.factory_yml` に保存するところまでを行う。
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type Clock, isoNow } from "./clock.ts";
import { formatZodError } from "./config.ts";
import type { Db } from "./db.ts";
import { insertEvent } from "./events.ts";
import type { GitHubApi } from "./github.ts";
import type { Logger } from "./log.ts";

export const FACTORY_YML_PATH = "factory.yml";

const Command = z.string().min(1);

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
      protected: z.array(z.string().min(1)).default([]),
      forbidden: z.array(z.string().min(1)).default([]),
    })
    .default({ protected: [], forbidden: [] }),
  limits: z
    .strictObject({
      max_parallel: z.number().int().min(1).default(1),
      max_attempts: z.number().int().min(1).default(3),
    })
    .default({ max_parallel: 1, max_attempts: 3 }),
  issues: z.strictObject({
    allowed_authors: z.array(z.string().min(1)),
  }),
});

export type FactoryYml = z.infer<typeof FactoryYmlSchema>;

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
 * 保存してある内容も、使う前に検証し直す。
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
