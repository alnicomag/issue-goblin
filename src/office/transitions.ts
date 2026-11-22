/**
 * イシューの状態遷移表。
 *
 * ここにある関数は純粋関数で、DBにもGitHubにも触れない。
 * 人間がGitHub上でラベルを手で変えた場合は、この表による検査の対象外とする
 * (GitHubが正なので、同期はそのまま受け入れる)。
 */

/** イシューの状態。`closed` 以外は `state:` ラベルで表す。 */
export const ISSUE_STATES = [
  "triage",
  "needs-info",
  "blocked",
  "ready",
  "in-progress",
  "in-review",
  "failed",
  "closed",
] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** 遷移元。`new` は、まだ状態を持たない新規のイシューを表す。 */
export const TRANSITION_SOURCES = ["new", ...ISSUE_STATES] as const;
export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

/** 遷移の実行者。office は事務局、conductor は司令塔、human は人間。 */
export const ACTORS = ["office", "conductor", "human"] as const;
export type Actor = (typeof ACTORS)[number];

export interface Transition {
  readonly from: TransitionSource;
  readonly to: IssueState;
  readonly actor: Actor;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "new", to: "triage", actor: "office" },
  { from: "triage", to: "ready", actor: "conductor" },
  { from: "triage", to: "needs-info", actor: "conductor" },
  { from: "triage", to: "blocked", actor: "conductor" },
  { from: "needs-info", to: "triage", actor: "office" },
  { from: "blocked", to: "triage", actor: "office" },
  { from: "ready", to: "in-progress", actor: "office" },
  { from: "in-progress", to: "in-review", actor: "office" },
  { from: "in-progress", to: "needs-info", actor: "office" },
  { from: "in-progress", to: "ready", actor: "office" },
  { from: "in-progress", to: "failed", actor: "office" },
  { from: "in-review", to: "in-progress", actor: "office" },
  { from: "in-review", to: "closed", actor: "human" },
  { from: "failed", to: "triage", actor: "office" },
];

/** 「遷移元、遷移先、実行者」の組が遷移表にあるかを返す。表にない遷移は拒否する。 */
export function isTransitionAllowed(
  from: TransitionSource,
  to: IssueState,
  actor: Actor,
): boolean {
  return TRANSITIONS.some(
    (t) => t.from === from && t.to === to && t.actor === actor,
  );
}

export function isIssueState(value: string): value is IssueState {
  return (ISSUE_STATES as readonly string[]).includes(value);
}
