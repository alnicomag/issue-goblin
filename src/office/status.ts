/**
 * 状況表示コマンド(`pnpm run status`)。
 * リポジトリごとに、状態別のイシュー数、未処理のイベント数、最後に同期した時刻、
 * 着手前の確認の結果(通らなかった場合は、コマンド、終了コード、出力の末尾)を表示する。
 * 続けて、全体について、当日に開始した実行の数と上限、進行中の実行、クローズ待ちの実行、
 * 再試行を待っているイシューを表示する。
 * DBは読み取り専用で開き、何も書き換えない。
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { systemClock } from "./clock.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import type { Db } from "./db.ts";
import {
  FAILED_RECHECK_MINUTES,
  IMAGE_BUILD_COMMAND,
  type PreflightRecord,
  readPreflight,
} from "./preflight.ts";
import type { StepName } from "./run-steps.ts";
import {
  countRunsStartedToday,
  findResumableRuns,
  retryNotBefore,
} from "./runs.ts";
import { ISSUE_STATES, type IssueState } from "./transitions.ts";

export interface RepoStatus {
  readonly repo: string;
  /** 状態別のイシュー数。遷移表にない状態の行があれば、それも含める。 */
  readonly issues: Readonly<Record<string, number>>;
  readonly unhandledEvents: number;
  readonly lastPolledAt: string | null;
  /** 着手前の確認の、最後に終わった結果。まだ確かめていなければ null。 */
  readonly preflight: PreflightRecord | null;
}

/** 状況表示に載せる、出力の末尾の行数の上限。全体は、ログのファイルにある。 */
export const STATUS_TAIL_LINES = 20;

/** 設定にあるリポジトリと、DBに記録のあるリポジトリの状況を集める。 */
export function collectStatus(
  db: Db,
  configuredRepos: readonly string[],
): RepoStatus[] {
  const known = db.prepare("SELECT repo, last_polled_at FROM repos").all() as {
    repo: string;
    last_polled_at: string | null;
  }[];
  const lastPolled = new Map(
    known.map((row) => [row.repo, row.last_polled_at]),
  );
  const repos = [
    ...configuredRepos,
    ...known.map((row) => row.repo).filter((r) => !configuredRepos.includes(r)),
  ];

  const countIssues = db.prepare(
    "SELECT state, COUNT(*) AS count FROM issues WHERE repo = ? GROUP BY state",
  );
  const countEvents = db.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE repo = ? AND handled_at IS NULL",
  );

  // 事務局を起動し直す前(マイグレーションの前)のDBには、確認の記録の置き場所がない。
  const hasPreflights =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preflights'",
      )
      .get() !== undefined;

  return repos.map((repo) => {
    const issues: Record<string, number> = Object.fromEntries(
      ISSUE_STATES.map((state: IssueState) => [state, 0]),
    );
    for (const row of countIssues.all(repo) as {
      state: string;
      count: number;
    }[]) {
      issues[row.state] = row.count;
    }
    const { count } = countEvents.get(repo) as { count: number };
    return {
      repo,
      issues,
      unhandledEvents: count,
      lastPolledAt: lastPolled.get(repo) ?? null,
      preflight: hasPreflights ? readPreflight(db, repo) : null,
    };
  });
}

/** 進行中の実行。 */
export interface ActiveRun {
  readonly repo: string;
  readonly issueNumber: number;
  readonly attempt: number;
  /** いま動いているステップ。ステップの合間なら、次に行うステップ。 */
  readonly step: StepName;
  readonly startedAt: string;
}

/** publish まで終わり、イシューのクローズを待っているだけの実行。 */
export interface WaitingCloseRun {
  readonly repo: string;
  readonly issueNumber: number;
  readonly attempt: number;
  readonly startedAt: string;
}

/** 失敗の後、再試行を待っているイシュー。 */
export interface RetryWait {
  readonly repo: string;
  readonly issueNumber: number;
  /** 次に再試行してよい時刻(UTCのISO 8601形式)。 */
  readonly retryAt: string;
}

/** 実行の状況。全リポジトリの合計。 */
export interface RunStatus {
  /** 当日(UTC)に開始した実行の数。着手のときと同じ数え方。 */
  readonly startedToday: number;
  /** 1日の実行数の上限(設定の `daily_run_limit`)。 */
  readonly dailyRunLimit: number;
  readonly active: readonly ActiveRun[];
  readonly waitingClose: readonly WaitingCloseRun[];
  readonly waitingRetry: readonly RetryWait[];
}

/**
 * 実行の状況を集める。DBを読むだけで、何も書かない。
 *
 * クローズ待ちは、残りが cleanup だけで、その cleanup がまだ始まっていない実行。
 * 再試行待ちは、着手の条件と同じく、`ready` で、再試行してよい時刻がまだ来ていないイシュー。
 */
export function collectRunStatus(
  db: Db,
  input: { now: Date; dailyRunLimit: number },
): RunStatus {
  const active: ActiveRun[] = [];
  const waitingClose: WaitingCloseRun[] = [];
  for (const { run, step, interrupted } of findResumableRuns(db)) {
    const base = {
      repo: run.repo,
      issueNumber: run.issueNumber,
      attempt: run.attempt,
      startedAt: run.startedAt,
    };
    if (step === "cleanup" && !interrupted) {
      waitingClose.push(base);
    } else {
      active.push({ ...base, step });
    }
  }

  const ready = db
    .prepare(
      "SELECT repo, number FROM issues WHERE state = 'ready' ORDER BY repo, number",
    )
    .all() as { repo: string; number: number }[];
  const waitingRetry: RetryWait[] = [];
  for (const issue of ready) {
    const retryAt = retryNotBefore(db, issue.repo, issue.number);
    if (retryAt !== null && Date.parse(retryAt) > input.now.getTime()) {
      waitingRetry.push({
        repo: issue.repo,
        issueNumber: issue.number,
        retryAt,
      });
    }
  }
  waitingRetry.sort((a, b) => Date.parse(a.retryAt) - Date.parse(b.retryAt));

  return {
    startedToday: countRunsStartedToday(db, input.now),
    dailyRunLimit: input.dailyRunLimit,
    active,
    waitingClose,
    waitingRetry,
  };
}

/** 見出しと、その下の行を足す。行がなければ「なし」と出す。列は幅をそろえる。 */
function pushSection(
  lines: string[],
  title: string,
  rows: readonly (readonly string[])[],
): void {
  if (rows.length === 0) {
    lines.push(`${title}: なし`);
    return;
  }
  lines.push(`${title}: ${rows.length}`);
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [],
  );
  for (const row of rows) {
    lines.push(
      `  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd(),
    );
  }
}

/**
 * 着手前の確認の結果を、表示の行にする。純粋関数。
 *
 * 通らなかった場合は、理由(コマンド、終了コード、出力の末尾)と、次に確かめ直す条件を出す。
 * 出力の末尾は、記録のときにトークンに見える文字列を伏せてある。
 */
export function preflightLines(record: PreflightRecord | null): string[] {
  if (record === null) return ["  着手前の確認: 未確認"];
  if (record.status === "passed") {
    return [
      `  着手前の確認: 通過(${record.checkedAt}、イメージ ${record.image})`,
    ];
  }
  const recheckAt = new Date(
    Date.parse(record.checkedAt) + FAILED_RECHECK_MINUTES * 60_000,
  );
  const exit = record.timedOut
    ? "時間切れ(時間の上限で止めました)"
    : record.exitCode === null
      ? record.command === IMAGE_BUILD_COMMAND
        ? "なし(ビルドを始めていないか、シグナルで終わりました)"
        : "なし(シグナルで終わりました)"
      : String(record.exitCode);
  const lines = [
    `  着手前の確認: 失敗(${record.checkedAt})。この製品には着手しません`,
    `    コマンド: ${record.command}`,
    `    終了コード: ${exit}`,
    `    イメージ: ${record.image}`,
    `    factory.yml: ${record.factoryYmlSha}`,
    ...(record.dockerfileSha === null
      ? []
      : [`    Dockerfile: ${record.dockerfileSha}`]),
    `    ログ: ${record.logPath}`,
    `    確かめ直し: イメージの名前、factory.yml、製品の Dockerfile のどれかが変わったとき、または ${
      Number.isNaN(recheckAt.getTime())
        ? "次のポーリング"
        : recheckAt.toISOString()
    } 以降`,
  ];
  const tail = record.outputTail.split("\n");
  if (record.outputTail.trim() === "") {
    lines.push("    出力の末尾: (出力なし)");
  } else {
    const shown = tail.slice(-STATUS_TAIL_LINES);
    lines.push(
      shown.length < tail.length
        ? `    出力の末尾(最後の ${shown.length} 行。全体はログにあります):`
        : "    出力の末尾:",
    );
    for (const line of shown) lines.push(`      | ${line}`.trimEnd());
  }
  return lines;
}

export function formatStatus(
  statuses: readonly RepoStatus[],
  runs: RunStatus,
): string {
  const lines: string[] = [];
  if (statuses.length === 0) lines.push("リポジトリがありません。", "");
  for (const status of statuses) {
    const total = Object.values(status.issues).reduce((a, b) => a + b, 0);
    lines.push(status.repo);
    lines.push(`  最終同期: ${status.lastPolledAt ?? "未同期"}`);
    lines.push(`  未処理のイベント: ${status.unhandledEvents}`);
    lines.push(...preflightLines(status.preflight));
    lines.push(`  イシュー: ${total}`);
    const width = Math.max(...Object.keys(status.issues).map((s) => s.length));
    for (const [state, count] of Object.entries(status.issues)) {
      lines.push(`    ${state.padEnd(width)}  ${count}`);
    }
    lines.push("");
  }

  lines.push(
    `当日(UTC)に開始した実行: ${runs.startedToday} / ${runs.dailyRunLimit}`,
    "",
  );
  pushSection(
    lines,
    "進行中の実行",
    runs.active.map((run) => [
      `${run.repo} #${run.issueNumber}`,
      `試行${run.attempt}`,
      run.step,
      `開始 ${run.startedAt}`,
    ]),
  );
  pushSection(
    lines,
    "クローズ待ちの実行",
    runs.waitingClose.map((run) => [
      `${run.repo} #${run.issueNumber}`,
      `試行${run.attempt}`,
      `開始 ${run.startedAt}`,
    ]),
  );
  pushSection(
    lines,
    "再試行を待っているイシュー",
    runs.waitingRetry.map((wait) => [
      `${wait.repo} #${wait.issueNumber}`,
      `再試行は ${wait.retryAt} 以降`,
    ]),
  );
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(config.db_path)) {
    throw new Error(
      `DBファイルがありません: ${config.db_path}(事務局をまだ起動していない可能性があります)`,
    );
  }
  const db = new Database(config.db_path, { readonly: true });
  try {
    const statuses = collectStatus(
      db,
      config.repos.map((repo) => repo.repo),
    );
    const runs = collectRunStatus(db, {
      now: systemClock.now(),
      dailyRunLimit: config.daily_run_limit,
    });
    process.stdout.write(formatStatus(statuses, runs));
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
