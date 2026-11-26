/**
 * 着手するイシューの選び方(段階1)。
 *
 * 段階1には司令塔がいないので、着手の指示を、ここにある決まった規則で代える。
 * ここにある関数は純粋関数で、DBにもネットワークにも触れない。
 * 事務局は判断を持たず、人間がラベルで決めた優先度の順に並べて、枠に収まる分だけを拾う。
 */
import type { Priority } from "./sync.ts";

/** 着手の候補になるイシュー。DBにある、GitHubの写しから作る。 */
export interface IntakeIssue {
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly priority: Priority | null;
  /** 起票者のログイン名。分からなければ null。 */
  readonly author: string | null;
  /** `agent:skip` が付いているか。 */
  readonly agentSkip: boolean;
  /** 失敗の後、次に再試行してよい時刻(UTCのISO 8601形式)。待機がなければ null。 */
  readonly retryAt: string | null;
}

/** リポジトリごとの、着手の条件。 */
export interface IntakeRepo {
  readonly repo: string;
  /** 自動で着手してよい起票者(`issues.allowed_authors`)。 */
  readonly allowedAuthors: readonly string[];
  /** 同時に進めてよい実行の数(`limits.max_parallel`)。 */
  readonly maxParallel: number;
  /** いま進んでいる実行の数。 */
  readonly active: number;
  /**
   * 着手前の確認(`preflight.ts`)の状態。
   * `passed` は通っている、`pending` は確認が済んでいない、`failed` は通らなかった。
   */
  readonly preflight: "passed" | "pending" | "failed";
}

/**
 * 着手しない理由。
 *
 * - `not_ready`: 状態が `ready` ではない。
 * - `unknown_repo`: 着手の条件を読めないリポジトリ(`factory.yml` が未取得または不正)。
 * - `agent_skip`: `agent:skip` が付いている。
 * - `author_not_allowed`: 起票者が `allowed_authors` にいない(分からない場合を含む)。
 * - `waiting_retry`: 失敗の後の待機時間が過ぎていない。
 * - `preflight_pending`: 着手前の確認が済んでいない(確かめている途中を含む)。
 * - `preflight_failed`: 着手前の確認で、`commands.setup` がワーカーのイメージで通らなかった。
 * - `no_slot`: 同時実行の枠がない。
 * - `daily_limit`: 1日の実行数の上限に達した。
 */
export type SkipReason =
  | "not_ready"
  | "unknown_repo"
  | "agent_skip"
  | "author_not_allowed"
  | "waiting_retry"
  | "preflight_pending"
  | "preflight_failed"
  | "no_slot"
  | "daily_limit";

const PRIORITY_ORDER: readonly Priority[] = ["p0", "p1", "p2", "p3"];

/** 優先度の順位。小さいほど先。ラベルなしは最後。 */
function priorityRank(priority: Priority | null): number {
  return priority === null
    ? PRIORITY_ORDER.length
    : PRIORITY_ORDER.indexOf(priority);
}

/**
 * 着手の順に並べる。
 *
 * `priority:` の高い順(`p0` が最初、ラベルなしは最後)、同じならイシュー番号の若い順。
 * 複数のリポジトリにまたがるときは、優先度が同じなら `repoOrder`(設定に書いた順)の先のものを先にする。
 */
export function orderForIntake<T extends IntakeIssue>(
  issues: readonly T[],
  repoOrder: readonly string[] = [],
): T[] {
  const repoRank = (repo: string) => {
    const index = repoOrder.indexOf(repo);
    return index === -1 ? repoOrder.length : index;
  };
  return [...issues].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      repoRank(a.repo) - repoRank(b.repo) ||
      a.repo.localeCompare(b.repo) ||
      a.number - b.number,
  );
}

/**
 * ログイン名が、許可された一覧(`issues.allowed_authors`)にあるか。分からない(null)なら false。
 * GitHubのログイン名は、大文字と小文字を区別しない。
 */
export function isAllowedLogin(
  login: string | null,
  allowed: readonly string[],
): boolean {
  if (login === null) return false;
  const lowered = login.toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === lowered);
}

/**
 * イシューそのものと、その製品の条件で、着手できない理由を返す。着手できるなら null。
 * 枠(同時実行、1日の上限)は、ここでは見ない。
 *
 * 着手前の確認は、最後に見る。ほかの理由で着手しないイシューしかない製品では、
 * 確認が要るとはみなさない。
 */
export function intakeBlocker(
  issue: IntakeIssue,
  repo: IntakeRepo | undefined,
  now: Date,
): SkipReason | null {
  if (issue.state !== "ready") return "not_ready";
  if (repo === undefined) return "unknown_repo";
  if (issue.agentSkip) return "agent_skip";
  if (!isAllowedLogin(issue.author, repo.allowedAuthors)) {
    return "author_not_allowed";
  }
  if (issue.retryAt !== null && Date.parse(issue.retryAt) > now.getTime()) {
    return "waiting_retry";
  }
  if (repo.preflight === "pending") return "preflight_pending";
  if (repo.preflight === "failed") return "preflight_failed";
  return null;
}

export interface IntakePlan<T extends IntakeIssue> {
  /** 着手するイシュー。着手の順に並んでいる。 */
  readonly starts: readonly T[];
  /** 着手しないイシューと、その理由。 */
  readonly skipped: readonly {
    readonly issue: T;
    readonly reason: SkipReason;
  }[];
}

/**
 * 着手するイシューを決める。
 *
 * 着手の順に見ていき、条件を満たし、枠に収まるものを拾う。
 * 着手前の確認が通っていない製品のイシューは、枠を数える前に外すので、ほかの製品の枠を取らない。
 * 枠は、リポジトリごとの同時実行数(`maxParallel`)と、全体の1日の実行数(`dailyLimit`)の2つ。
 */
export function planIntake<T extends IntakeIssue>(input: {
  issues: readonly T[];
  /** 設定に書いた順のリポジトリ。 */
  repos: readonly IntakeRepo[];
  /** UTCの1日に着手する実行の数の上限(全リポジトリの合計)。 */
  dailyLimit: number;
  /** 今日(UTC)すでに開始した実行の数。 */
  startedToday: number;
  now: Date;
}): IntakePlan<T> {
  const repos = new Map(input.repos.map((repo) => [repo.repo, repo]));
  const active = new Map(input.repos.map((repo) => [repo.repo, repo.active]));
  let startedToday = input.startedToday;

  const starts: T[] = [];
  const skipped: { issue: T; reason: SkipReason }[] = [];
  const ordered = orderForIntake(
    input.issues,
    input.repos.map((repo) => repo.repo),
  );
  for (const issue of ordered) {
    const repo = repos.get(issue.repo);
    const blocker = intakeBlocker(issue, repo, input.now);
    if (blocker !== null || repo === undefined) {
      skipped.push({ issue, reason: blocker ?? "unknown_repo" });
      continue;
    }
    const running = active.get(issue.repo) ?? 0;
    if (running >= repo.maxParallel) {
      skipped.push({ issue, reason: "no_slot" });
      continue;
    }
    if (startedToday >= input.dailyLimit) {
      skipped.push({ issue, reason: "daily_limit" });
      continue;
    }
    active.set(issue.repo, running + 1);
    startedToday += 1;
    starts.push(issue);
  }
  return { starts, skipped };
}

/** `now` を含むUTCの1日の、始まりの時刻(UTCのISO 8601形式)。 */
export function utcDayStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}
