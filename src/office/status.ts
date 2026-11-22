/**
 * 状況表示コマンド(`pnpm run status`)。
 * リポジトリごとに、状態別のイシュー数、未処理のイベント数、最後に同期した時刻を表示する。
 * DBは読み取り専用で開き、何も書き換えない。
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { ISSUE_STATES, type IssueState } from "./transitions.ts";

export interface RepoStatus {
  readonly repo: string;
  /** 状態別のイシュー数。遷移表にない状態の行があれば、それも含める。 */
  readonly issues: Readonly<Record<string, number>>;
  readonly unhandledEvents: number;
  readonly lastPolledAt: string | null;
}

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
    };
  });
}

export function formatStatus(statuses: readonly RepoStatus[]): string {
  if (statuses.length === 0) return "リポジトリがありません。\n";
  const lines: string[] = [];
  for (const status of statuses) {
    const total = Object.values(status.issues).reduce((a, b) => a + b, 0);
    lines.push(status.repo);
    lines.push(`  最終同期: ${status.lastPolledAt ?? "未同期"}`);
    lines.push(`  未処理のイベント: ${status.unhandledEvents}`);
    lines.push(`  イシュー: ${total}`);
    const width = Math.max(...Object.keys(status.issues).map((s) => s.length));
    for (const [state, count] of Object.entries(status.issues)) {
      lines.push(`    ${state.padEnd(width)}  ${count}`);
    }
    lines.push("");
  }
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
    process.stdout.write(formatStatus(statuses));
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
