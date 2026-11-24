/**
 * 着手前の確認: 製品の `commands.setup` が、その製品のワーカーのイメージで通ることを確かめる。
 *
 * 検査コマンドに要るツールがイメージにないと、実行は implement か verify まで進んでから失敗し、
 * 再試行しても直らない。Claudeを呼ぶ前に気づけるように、着手の前に `setup` だけを実行してみる。
 *
 * 実行の経路は verify と同じである。起動係を通して、ワーカーと同じ種類の使い捨てのコンテナで
 * `sh -c <コマンド>` を実行する。Claudeのトークンは求めない。コマンドは、事務局が同期して保存した
 * `factory.yml` から読む。場所は、製品ごとの確認用の作業場所で、確認のたびに、既定ブランチの
 * 最新から作り直す。イシューの作業場所には触れない。
 *
 * 結果は製品ごとに1行、`preflights` に残す。確かめ直すかどうかは、記録だけから純粋関数
 * (`decidePreflight`)で決める。事務局は、結果の解釈(製品の側の失敗か、環境の側の失敗か)を
 * 持たない。通らなければ着手しない、というだけである。
 */
import { z } from "zod";
import {
  LauncherAbortedError,
  type WorkerLauncher,
} from "../launcher/client.ts";
import type { RunResult } from "../launcher/request.ts";
import type { Clock } from "./clock.ts";
import type { Db } from "./db.ts";
import type { Git } from "./git.ts";
import { errorFields, type Logger } from "./log.ts";
import { readStoredFactoryYml } from "./product.ts";
import { maskSecrets, preflightLogDir, writeStepLog } from "./step-log.ts";
import { buildVerifyArgv, interpretCommand } from "./verify.ts";
import {
  cleanupPreflightWorkspace,
  preparePreflightWorkspace,
  type RepoSource,
  type WorkspaceAuthor,
  type WorkspaceDirs,
} from "./workspace.ts";

/** 通らなかった結果を、同じ条件のまま確かめ直すまでの間隔(分)。 */
export const FAILED_RECHECK_MINUTES = 60;

/** 最後に終わった確認の記録(`preflights` の1行)。 */
export interface PreflightRecord {
  readonly repo: string;
  readonly status: "passed" | "failed";
  /** 確かめたときの、ワーカーのイメージの名前。 */
  readonly image: string;
  /** 確かめたときの `factory.yml` の sha。 */
  readonly factoryYmlSha: string;
  /** 実行した `commands.setup`。 */
  readonly command: string;
  /** 終了コード。シグナルで終わった場合は null。 */
  readonly exitCode: number | null;
  /** 時間の上限で止めたか。 */
  readonly timedOut: boolean;
  /** 通らなかった場合の、出力の末尾。トークンに見える文字列は伏せてある。 */
  readonly outputTail: string;
  /** 出力の全体を残したログの場所。 */
  readonly logPath: string;
  /** 確認が終わった時刻(UTCのISO 8601形式)。 */
  readonly checkedAt: string;
}

/**
 * - `passed`: いまの条件で通っている。着手してよい。
 * - `failed`: いまの条件で通らなかった。確かめ直す時刻も来ていない。着手しない。
 * - `check`: 確かめる(まだ確かめていないか、条件が変わったか、確かめ直す時刻が来た)。
 */
export type PreflightDecision = "passed" | "failed" | "check";

/**
 * 記録から、着手してよいか、確かめるかを決める純粋関数。
 *
 * 条件は、ワーカーのイメージの名前と、`factory.yml` の sha の2つである。
 *
 * - 記録がないか、条件のどちらかが記録と違えば、確かめる。
 * - 条件が同じで、通っていれば、確かめ直さない。
 * - 条件が同じで、通らなかった場合は、前回から `FAILED_RECHECK_MINUTES` 分たったら確かめ直す。
 *   事務局はイメージの中身を見られないので、同じ名前のまま作り直されたことを、時間で拾う。
 * - `factory.yml` の sha が分からない(未取得)なら、確かめる。
 */
export function decidePreflight(input: {
  record: PreflightRecord | null;
  image: string;
  factoryYmlSha: string | null;
  now: Date;
}): PreflightDecision {
  const { record, image, factoryYmlSha, now } = input;
  if (
    record === null ||
    factoryYmlSha === null ||
    record.image !== image ||
    record.factoryYmlSha !== factoryYmlSha
  ) {
    return "check";
  }
  if (record.status === "passed") return "passed";
  const recheckAt =
    Date.parse(record.checkedAt) + FAILED_RECHECK_MINUTES * 60_000;
  // 時刻を読めない記録は、当てにせず、確かめ直す。
  return Number.isNaN(recheckAt) || now.getTime() >= recheckAt
    ? "check"
    : "failed";
}

const RowSchema = z.object({
  repo: z.string(),
  status: z.enum(["passed", "failed"]),
  image: z.string(),
  factory_yml_sha: z.string(),
  command: z.string(),
  exit_code: z.number().int().nullable(),
  timed_out: z.number().int(),
  output_tail: z.string(),
  log_path: z.string(),
  checked_at: z.string(),
});

/** 製品の、最後に終わった確認の記録を読む。なければ null。 */
export function readPreflight(db: Db, repo: string): PreflightRecord | null {
  const row = db.prepare("SELECT * FROM preflights WHERE repo = ?").get(repo);
  if (row === undefined) return null;
  const parsed = RowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`着手前の確認の記録が想定外の内容です(${repo})`, {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  return {
    repo: data.repo,
    status: data.status,
    image: data.image,
    factoryYmlSha: data.factory_yml_sha,
    command: data.command,
    exitCode: data.exit_code,
    timedOut: data.timed_out !== 0,
    outputTail: data.output_tail,
    logPath: data.log_path,
    checkedAt: data.checked_at,
  };
}

/** 確認の記録を残す。製品ごとに1行で、前の記録は置き換える。 */
export function savePreflight(db: Db, record: PreflightRecord): void {
  db.prepare(
    `INSERT INTO preflights
       (repo, status, image, factory_yml_sha, command, exit_code, timed_out,
        output_tail, log_path, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET
       status = excluded.status,
       image = excluded.image,
       factory_yml_sha = excluded.factory_yml_sha,
       command = excluded.command,
       exit_code = excluded.exit_code,
       timed_out = excluded.timed_out,
       output_tail = excluded.output_tail,
       log_path = excluded.log_path,
       checked_at = excluded.checked_at`,
  ).run(
    record.repo,
    record.status,
    record.image,
    record.factoryYmlSha,
    record.command,
    record.exitCode,
    record.timedOut ? 1 : 0,
    // 念のため、残す直前にも伏せる。
    maskSecrets(record.outputTail),
    record.logPath,
    record.checkedAt,
  );
}

/** 保存してある `factory.yml` の sha。行がないか、未取得なら null。 */
export function storedFactoryYmlSha(db: Db, repo: string): string | null {
  const row = db
    .prepare("SELECT factory_yml_sha AS sha FROM repos WHERE repo = ?")
    .get(repo) as { sha: string | null } | undefined;
  return row?.sha ?? null;
}

export interface PreflightDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly git: Git;
  /** 起動係に依頼する口。 */
  readonly launcher: WorkerLauncher;
  /** 置き場所(設定の `repos_dir`、`work_dir`)。 */
  readonly dirs: WorkspaceDirs;
  /** ログの置き場所(設定の `logs_dir`)。 */
  readonly logsDir: string;
  /** リポジトリの取得元。 */
  readonly sourceFor: (repo: string) => RepoSource;
  /** cloneのgit設定に書く作者(設定の `commit_author`)。イシューの作業場所と同じ形にするために渡す。 */
  readonly commitAuthor: WorkspaceAuthor;
}

export interface PreflightInput {
  /** 対象のリポジトリ(owner/name)。設定にある書き方で渡す。 */
  readonly repo: string;
  /** その製品のワーカーのイメージの名前(設定のもの)。記録に残す。 */
  readonly image: string;
  /** `setup` の時間の上限(秒)。過ぎたら、起動係がコンテナごと止める。 */
  readonly timeoutSec: number;
  /** 止める合図(事務局の停止)。 */
  readonly signal?: AbortSignal;
}

/**
 * - `recorded`: 確認が終わり、結果を記録した。
 * - `not_run`: 確認を実行できなかった(`factory.yml` を読めない、取得の失敗、依頼の拒否、
 *   起動係に届かない)。結果ではないので、記録しない。
 * - `interrupted`: 途中で、依頼した側が止めた(事務局の停止)。記録しない。
 */
export type PreflightResult =
  | { readonly kind: "recorded"; readonly record: PreflightRecord }
  | { readonly kind: "not_run"; readonly reason: string }
  | { readonly kind: "interrupted" };

function logText(header: Record<string, unknown>, run: RunResult): string {
  return [
    JSON.stringify(header, null, 2),
    "--- setup stdout ---",
    run.stdout,
    "--- setup stderr ---",
    run.stderr,
    "",
  ].join("\n");
}

/**
 * 確認を1回行う。確認用の作業場所を作り直し、`commands.setup` を実行し、結果を記録して、
 * 作業場所を消す。
 *
 * コマンドの失敗と時間切れは、結果(`failed`)として記録する。実行できなかった場合と、
 * 止められた場合は、記録せずに返す。GitHubには何も書かない。
 * やり直して安全で、呼ぶたびに新しいログのファイルを作る。
 */
export async function runPreflight(
  deps: PreflightDeps,
  input: PreflightInput,
): Promise<PreflightResult> {
  const { db, clock } = deps;
  const { repo, image, timeoutSec, signal } = input;
  // 呼ぶたびに読む(待っている間に、止められているかもしれない)。
  const aborted = (): boolean => signal?.aborted === true;
  const notRun = (error: unknown): PreflightResult => ({
    kind: "not_run",
    reason: maskSecrets(error instanceof Error ? error.message : String(error)),
  });

  // 条件(sha)とコマンドは、同じ時点のものを使う。
  const factoryYmlSha = storedFactoryYmlSha(db, repo);
  let command: string;
  try {
    command = readStoredFactoryYml(db, repo).commands.setup;
  } catch (error) {
    return notRun(error);
  }
  if (factoryYmlSha === null) {
    return notRun(new Error(`リポジトリ ${repo} の factory.yml は未取得です`));
  }

  const startedAt = clock.now();
  try {
    try {
      await preparePreflightWorkspace(
        { git: deps.git },
        {
          dirs: deps.dirs,
          repo,
          source: deps.sourceFor(repo),
          author: deps.commitAuthor,
        },
      );
    } catch (error) {
      return aborted() ? { kind: "interrupted" } : notRun(error);
    }
    if (aborted()) return { kind: "interrupted" };

    let run: RunResult;
    try {
      run = await deps.launcher.run(
        {
          repo,
          workspace: "preflight",
          argv: buildVerifyArgv(command),
          // 製品のコードを実行するコンテナには、Claudeのトークンを渡さない。
          claude_token: false,
          timeout_sec: timeoutSec,
        },
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      return error instanceof LauncherAbortedError
        ? { kind: "interrupted" }
        : notRun(error);
    }
    // 止められた後の結果は、中断によるものかもしれないので、記録しない。
    if (aborted()) return { kind: "interrupted" };

    const finishedAt = clock.now();
    const result = interpretCommand(
      "setup",
      command,
      run,
      finishedAt.getTime() - startedAt.getTime(),
    );
    const status = result.status === "passed" ? "passed" : "failed";
    const logPath = writeStepLog({
      dir: preflightLogDir(deps.logsDir, repo),
      startedAt,
      step: "preflight",
      text: logText(
        {
          repo,
          step: "preflight",
          image,
          factory_yml_sha: factoryYmlSha,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          timeout_sec: timeoutSec,
          outcome: status,
          command,
          exit_code: result.exitCode,
          timed_out: run.timed_out,
          truncated: run.truncated,
        },
        run,
      ),
    });
    const record: PreflightRecord = {
      repo,
      status,
      image,
      factoryYmlSha,
      command,
      exitCode: result.exitCode,
      timedOut: run.timed_out,
      outputTail: result.outputTail,
      logPath,
      checkedAt: finishedAt.toISOString(),
    };
    savePreflight(db, record);
    return { kind: "recorded", record };
  } finally {
    // `setup` が作ったもの(依存など)を残さない。次の確認も、作り直すところから始める。
    cleanupPreflightWorkspace({ dirs: deps.dirs, repo });
  }
}

/**
 * 着手の条件としての、確認の状態。
 *
 * - `passed`: 通っている。
 * - `pending`: 確認が要る(まだ確かめていない、確かめている途中、条件が変わった)。
 * - `failed`: 通らなかった。
 */
export type PreflightStatus = "passed" | "pending" | "failed";

/**
 * 着手の前の関門。`supervisor.ts` は、この口を通して確認の状態を読み、確認を始める。
 * テストでは、偽の実装に差し替えられる。
 */
export interface PreflightGate {
  /** 製品の、いまの確認の状態。記録を読むだけで、何も変えない。 */
  statusOf(repo: string): PreflightStatus;
  /**
   * 確認が要るなら、裏で始める。終わるのを待たない。すでに確かめている途中か、
   * 確認が要らなければ、何もしない。結果は、次に `statusOf` を呼んだときに読める。
   */
  ensure(repo: string): void;
  /** 確かめている途中の確認を止めて、止まるまで待つ。以後は、新しい確認を始めない。 */
  stop(): Promise<void>;
  /** 確かめている途中の確認が、すべて終わるまで待つ。 */
  idle(): Promise<void>;
}

export interface PreflightGateDeps extends PreflightDeps {
  readonly logger: Logger;
  /** 製品のワーカーのイメージの名前(設定の `worker_image`)。 */
  readonly imageFor: (repo: string) => string;
  /** `setup` の時間の上限(秒)。verify のコマンドの上限と同じ値を渡す。 */
  readonly timeoutSec: number;
}

export function createPreflightGate(deps: PreflightGateDeps): PreflightGate {
  const { db, clock, logger } = deps;
  const tasks = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  let stopping = false;

  const decide = (repo: string): PreflightDecision =>
    decidePreflight({
      record: readPreflight(db, repo),
      image: deps.imageFor(repo),
      factoryYmlSha: storedFactoryYmlSha(db, repo),
      now: clock.now(),
    });

  async function check(repo: string, signal: AbortSignal): Promise<void> {
    const image = deps.imageFor(repo);
    logger.info("preflight.started", { repo, image });
    const result = await runPreflight(deps, {
      repo,
      image,
      timeoutSec: deps.timeoutSec,
      signal,
    });
    if (result.kind === "interrupted") {
      logger.info("preflight.interrupted", { repo });
      return;
    }
    if (result.kind === "not_run") {
      logger.warn("preflight.not_run", { repo, image, reason: result.reason });
      return;
    }
    const { record } = result;
    if (record.status === "passed") {
      logger.info("preflight.passed", {
        repo,
        image,
        factory_yml_sha: record.factoryYmlSha,
        log_path: record.logPath,
      });
      return;
    }
    logger.warn("preflight.failed", {
      repo,
      image,
      factory_yml_sha: record.factoryYmlSha,
      command: record.command,
      exit_code: record.exitCode,
      timed_out: record.timedOut,
      output_tail: record.outputTail,
      log_path: record.logPath,
    });
  }

  return {
    statusOf(repo) {
      const decision = decide(repo);
      return decision === "check" ? "pending" : decision;
    },

    ensure(repo) {
      if (stopping || tasks.has(repo) || decide(repo) !== "check") return;
      const controller = new AbortController();
      const done = check(repo, controller.signal)
        .catch((error: unknown) => {
          // 1つの製品の確認の失敗で、ほかの処理を止めない。次のポーリングでやり直す。
          logger.error("preflight.crashed", { repo, ...errorFields(error) });
        })
        .finally(() => {
          tasks.delete(repo);
        });
      tasks.set(repo, { controller, done });
    },

    async stop() {
      stopping = true;
      const pending = [...tasks.values()];
      for (const task of pending) task.controller.abort();
      await Promise.all(pending.map((task) => task.done));
    },

    async idle() {
      while (tasks.size > 0) {
        await Promise.all([...tasks.values()].map((task) => task.done));
      }
    },
  };
}
