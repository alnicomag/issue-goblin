/**
 * GitHubとの同期(ポーリングによる取り込み)。
 *
 * GitHubが正。人間がラベルを手で変えた場合も、遷移表による検査はせずにそのまま受け入れる。
 * 同じ変更を2回処理しても、イベントが二重に記録されないようにしている。
 * イシューのイベントは、DBにある現在の内容との差分があるときだけ記録する。
 * 差分に現れないもの(ラベルの競合、ラベル付け)は `github_updated_at` が進んだときだけ扱う。
 * コメントは、コメントIDで既出かを確かめる。
 */
import { type Clock, isoNow } from "./clock.ts";
import type { Db } from "./db.ts";
import { insertEvent } from "./events.ts";
import {
  addLabels,
  type GitHubApi,
  type GitHubComment,
  type GitHubIssue,
  type WriteContext,
} from "./github.ts";
import { errorFields, type Logger } from "./log.ts";
import { syncFactoryYml } from "./product.ts";
import { type IssueState, isIssueState } from "./transitions.ts";

export const STATE_LABEL_PREFIX = "state:";
export const TRIAGE_LABEL = "state:triage";
/** ファクトリー自身が書いたコメントに付ける目印。 */
export const FACTORY_COMMENT_MARKER = "<!-- factory -->";

const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
const SIZES = ["s", "m", "l"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Size = (typeof SIZES)[number];

export type StateProblem =
  | { readonly kind: "conflict"; readonly labels: readonly string[] }
  | { readonly kind: "unknown"; readonly labels: readonly string[] };

export interface DerivedIssue {
  /** ラベルから決まった状態。決められない場合(競合、未知の値)は null。 */
  readonly state: IssueState | null;
  readonly problem: StateProblem | null;
  /** オープンで `state:` ラベルがなく、`state:triage` を付けるべきか。 */
  readonly needsTriageLabel: boolean;
  readonly priority: Priority | null;
  readonly size: Size | null;
  readonly warnings: readonly string[];
}

/** イシューの開閉とラベルから、状態、優先度、規模を導く。純粋関数。 */
export function deriveIssue(issue: {
  open: boolean;
  labels: readonly string[];
}): DerivedIssue {
  const warnings: string[] = [];
  const priority = pickOne(issue.labels, "priority:", PRIORITIES, warnings);
  const size = pickOne(issue.labels, "size:", SIZES, warnings);
  const base = { priority, size, warnings, needsTriageLabel: false };

  if (!issue.open) {
    return { ...base, state: "closed", problem: null };
  }

  const stateLabels = issue.labels.filter((label) =>
    label.startsWith(STATE_LABEL_PREFIX),
  );
  if (stateLabels.length === 0) {
    return { ...base, state: "triage", problem: null, needsTriageLabel: true };
  }
  if (stateLabels.length > 1) {
    return {
      ...base,
      state: null,
      problem: { kind: "conflict", labels: stateLabels },
    };
  }
  const value = (stateLabels[0] as string).slice(STATE_LABEL_PREFIX.length);
  // `closed` はラベルではなく、イシューのクローズで表す。
  if (!isIssueState(value) || value === "closed") {
    return {
      ...base,
      state: null,
      problem: { kind: "unknown", labels: stateLabels },
    };
  }
  return { ...base, state: value, problem: null };
}

function pickOne<T extends string>(
  labels: readonly string[],
  prefix: string,
  allowed: readonly T[],
  warnings: string[],
): T | null {
  const found = labels.filter((label) => label.startsWith(prefix));
  if (found.length === 0) return null;
  if (found.length > 1) {
    warnings.push(`${prefix} のラベルが複数あります: ${found.join(", ")}`);
    return null;
  }
  const value = (found[0] as string).slice(prefix.length);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    warnings.push(`${prefix} のラベルの値が不明です: ${found[0]}`);
    return null;
  }
  return match;
}

// ---------------------------------------------------------------------------

export interface SyncDeps {
  readonly db: Db;
  /** リポジトリごとの通信の口を返す(トークンがリポジトリごとに違うため)。 */
  readonly apiFor: (repo: string) => GitHubApi;
  readonly dryRun: boolean;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface RepoSyncResult {
  readonly repo: string;
  readonly ok: boolean;
  /** 取得して処理したイシューの数(プルリクエストと、変更のないものを除く)。 */
  readonly issues: number;
  /** 記録したコメントの数。 */
  readonly comments: number;
  /** 記録したイベントの数。 */
  readonly events: number;
}

/**
 * 設定にあるすべてのリポジトリを同期する。
 * 1つのリポジトリで失敗しても、ログに出して次へ進む。失敗した分は次回のポーリングでやり直す。
 */
export async function syncAll(
  deps: SyncDeps,
  repos: readonly string[],
): Promise<RepoSyncResult[]> {
  const results: RepoSyncResult[] = [];
  for (const repo of repos) {
    try {
      const result = await syncRepo(deps, repo);
      deps.logger.info("sync.repo_done", { ...result });
      results.push(result);
    } catch (error) {
      deps.logger.error("sync.repo_failed", { repo, ...errorFields(error) });
      results.push({ repo, ok: false, issues: 0, comments: 0, events: 0 });
    }
  }
  return results;
}

interface RepoRow {
  issues_synced_until: string | null;
  comments_synced_until: string | null;
}

interface IssueRow {
  title: string;
  state: string;
  priority: string | null;
  size: string | null;
  github_updated_at: string;
}

export async function syncRepo(
  deps: SyncDeps,
  repo: string,
): Promise<RepoSyncResult> {
  const { db, clock, logger } = deps;
  const api = deps.apiFor(repo);
  const write: WriteContext = { api, dryRun: deps.dryRun, logger };

  db.prepare("INSERT OR IGNORE INTO repos (repo) VALUES (?)").run(repo);
  const position = db
    .prepare(
      "SELECT issues_synced_until, comments_synced_until FROM repos WHERE repo = ?",
    )
    .get(repo) as RepoRow;

  let events = 0;

  // 1〜4. イシュー
  const issues = await api.listIssues(repo, position.issues_synced_until);
  let processedIssues = 0;
  for (const issue of issues) {
    if (issue.isPullRequest) continue;
    const recorded = await syncIssue(deps, write, repo, issue);
    if (recorded !== null) {
      processedIssues += 1;
      events += recorded;
    }
  }
  const issuesUntil = latest(
    position.issues_synced_until,
    issues.map((issue) => issue.updatedAt),
  );
  db.prepare("UPDATE repos SET issues_synced_until = ? WHERE repo = ?").run(
    issuesUntil,
    repo,
  );

  // 5. コメント
  const comments = await api.listIssueComments(
    repo,
    position.comments_synced_until,
  );
  let recordedComments = 0;
  for (const comment of comments) {
    if (recordComment(db, repo, comment, isoNow(clock))) {
      recordedComments += 1;
      events += 1;
    }
  }
  const commentsUntil = latest(
    position.comments_synced_until,
    comments.map((comment) => comment.updatedAt),
  );
  db.prepare("UPDATE repos SET comments_synced_until = ? WHERE repo = ?").run(
    commentsUntil,
    repo,
  );

  // factory.yml
  await syncFactoryYml({ db, api, repo, clock, logger });

  // 6. 最後に同期した時刻
  db.prepare("UPDATE repos SET last_polled_at = ? WHERE repo = ?").run(
    isoNow(clock),
    repo,
  );

  return {
    repo,
    ok: true,
    issues: processedIssues,
    comments: recordedComments,
    events,
  };
}

/**
 * イシュー1件を取り込む。
 * 戻り値は記録したイベントの数。すでに取り込み済みの内容なら null。
 */
async function syncIssue(
  deps: SyncDeps,
  write: WriteContext,
  repo: string,
  issue: GitHubIssue,
): Promise<number | null> {
  const { db, clock, logger } = deps;
  const existing = db
    .prepare(
      `SELECT title, state, priority, size, github_updated_at
       FROM issues WHERE repo = ? AND number = ?`,
    )
    .get(repo, issue.number) as IssueRow | undefined;

  const derived = deriveIssue(issue);
  // 前回の取り込みより後に更新されたか。取得範囲は前回と重なるので、
  // 同じ内容がもう一度届くことがある(再起動の後も同じ)。
  const fresh =
    existing === undefined || issue.updatedAt > existing.github_updated_at;
  if (existing !== undefined && !fresh) {
    const state = derived.state ?? existing.state;
    const unchanged =
      state === existing.state &&
      issue.title === existing.title &&
      derived.priority === existing.priority &&
      derived.size === existing.size;
    if (unchanged) return null;
  }

  for (const warning of derived.warnings) {
    logger.warn("sync.label_warning", { repo, issue: issue.number, warning });
  }
  if (derived.problem?.kind === "unknown") {
    logger.error("sync.unknown_state_label", {
      repo,
      issue: issue.number,
      labels: derived.problem.labels,
    });
  }

  // ラベル付けはDBの更新より先に行う。失敗したら行を書かずに例外を投げ、
  // 次回のポーリングで同じイシューをやり直せるようにする。
  if (derived.needsTriageLabel && fresh) {
    await addLabels(write, repo, issue.number, [TRIAGE_LABEL]);
  }

  const now = isoNow(clock);
  const event = (
    type: Parameters<typeof insertEvent>[1]["type"],
    payload: Record<string, unknown>,
  ) =>
    insertEvent(db, {
      type,
      repo,
      issueNumber: issue.number,
      payload,
      createdAt: now,
    });

  let recorded = 0;
  db.transaction(() => {
    if (existing === undefined) {
      // 状態を決められない新規のイシューは、triage として扱う。
      const state: IssueState = derived.state ?? "triage";
      db.prepare(
        `INSERT INTO issues
           (repo, number, title, state, priority, size, github_updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        repo,
        issue.number,
        issue.title,
        state,
        derived.priority,
        derived.size,
        issue.updatedAt,
        now,
      );
      event("issue.created", {
        title: issue.title,
        state,
        priority: derived.priority,
        size: derived.size,
        author: issue.author,
      });
      recorded += 1;
      if (derived.problem?.kind === "conflict") {
        event("issue.label_conflict", {
          labels: derived.problem.labels,
          state,
        });
        recorded += 1;
      }
      return;
    }

    // 状態を決められないときは、状態を更新しない。
    const state = derived.state ?? existing.state;
    db.prepare(
      `UPDATE issues
         SET title = ?, state = ?, priority = ?, size = ?,
             github_updated_at = ?, synced_at = ?
       WHERE repo = ? AND number = ?`,
    ).run(
      issue.title,
      state,
      derived.priority,
      derived.size,
      fresh ? issue.updatedAt : existing.github_updated_at,
      now,
      repo,
      issue.number,
    );
    if (derived.problem?.kind === "conflict") {
      if (!fresh) return;
      event("issue.label_conflict", {
        labels: derived.problem.labels,
        state: existing.state,
      });
      recorded += 1;
    } else if (state !== existing.state) {
      if (state === "closed") {
        event("issue.closed", { from: existing.state });
      } else {
        event("issue.state_changed", { from: existing.state, to: state });
      }
      recorded += 1;
    }
  })();
  return recorded;
}

/** コメント1件を記録する。記録したら true。 */
function recordComment(
  db: Db,
  repo: string,
  comment: GitHubComment,
  now: string,
): boolean {
  // プルリクエストは取り込まないので、そこに付いたコメントも記録しない。
  if (comment.onPullRequest) return false;
  // ファクトリー自身のコメント。
  if (comment.body.includes(FACTORY_COMMENT_MARKER)) return false;

  const already = db
    .prepare(
      `SELECT 1 FROM events
       WHERE type = 'issue.commented' AND repo = ? AND issue_number = ?
         AND json_extract(payload, '$.comment_id') = ?`,
    )
    .get(repo, comment.issueNumber, comment.id);
  if (already !== undefined) return false;

  insertEvent(db, {
    type: "issue.commented",
    repo,
    issueNumber: comment.issueNumber,
    payload: {
      comment_id: comment.id,
      author: comment.author,
      body: comment.body,
      commented_at: comment.createdAt,
      updated_at: comment.updatedAt,
    },
    createdAt: now,
  });
  return true;
}

/** これまでの取得位置と、今回取得した更新時刻のうち、最も新しいもの。 */
function latest(
  current: string | null,
  timestamps: readonly string[],
): string | null {
  let result = current;
  for (const timestamp of timestamps) {
    if (result === null || timestamp > result) result = timestamp;
  }
  return result;
}
