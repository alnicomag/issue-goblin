/**
 * 事務局による、イシューの状態の変更。
 *
 * 状態を変えるときは、必ずここを通す。遷移表(`transitions.ts`)で検査し、
 * 表にある変更だけを、GitHubのラベルの付け替えとして実行する。
 * 表にない変更は、実行せずに、イベント(`issue.transition_rejected`)とログに残す。
 *
 * 遷移元は、引数ではなく、DBにあるGitHubの写しから読む。GitHubが正だからである。
 * 書き込んだ後、DBの状態も同じ値にする。次の同期が、事務局自身の変更を人間の変更と見誤らないためである。
 *
 * イシューが `failed` を離れたら、試行回数をリセットする(人間が方針を示した後は、別の取り組みとして扱う)。
 * 人間がラベルを手で変えて離れた場合は、ここを通らないので、`supervisor.ts` が同期の記録から行う。
 */
import { type Clock, isoNow } from "./clock.ts";
import type { Db } from "./db.ts";
import { insertEvent } from "./events.ts";
import { setStateLabel, type WriteContext } from "./github.ts";
import type { RepoLocks } from "./locks.ts";
import { resetAttempts } from "./runs.ts";
import {
  type IssueState,
  isIssueState,
  isTransitionAllowed,
} from "./transitions.ts";

export interface TransitionDeps {
  readonly db: Db;
  /** GitHubへの書き込みの口と、`dry_run`。 */
  readonly write: WriteContext;
  readonly clock: Clock;
  /** 同期と同じ排他。 */
  readonly locks: RepoLocks;
}

export interface TransitionRequest {
  readonly repo: string;
  readonly issue: number;
  readonly to: IssueState;
  /** なぜ変えるのか。ログと、却下の記録に残す。 */
  readonly reason: string;
}

/**
 * - `applied`: ラベルを付け替え、DBの状態も更新した。
 * - `unchanged`: すでにその状態だった。何も書いていない。
 * - `dry_run`: 遷移表は通ったが、`dry_run` なので書き込んでいない。DBの状態も変えていない。
 * - `rejected`: 遷移表にないので、実行しなかった。
 */
export type TransitionResult =
  | { readonly status: "applied"; readonly from: IssueState }
  | { readonly status: "unchanged" }
  | { readonly status: "dry_run"; readonly from: IssueState }
  | {
      readonly status: "rejected";
      readonly from: string;
      readonly reason: string;
    };

function currentState(db: Db, repo: string, issue: number): string {
  const row = db
    .prepare("SELECT state FROM issues WHERE repo = ? AND number = ?")
    .get(repo, issue) as { state: string } | undefined;
  if (row === undefined) {
    throw new Error(`イシューがありません: ${repo}#${issue}`);
  }
  return row.state;
}

/** 却下を記録する。同じ内容の未処理の記録があれば、重ねて書かない。 */
function recordRejection(
  deps: TransitionDeps,
  request: TransitionRequest,
  from: string,
): void {
  const { db } = deps;
  const already = db
    .prepare(
      `SELECT 1 FROM events
       WHERE type = 'issue.transition_rejected' AND repo = ? AND issue_number = ?
         AND handled_at IS NULL
         AND json_extract(payload, '$.from') = ?
         AND json_extract(payload, '$.to') = ?`,
    )
    .get(request.repo, request.issue, from, request.to);
  if (already === undefined) {
    insertEvent(db, {
      type: "issue.transition_rejected",
      repo: request.repo,
      issueNumber: request.issue,
      payload: {
        from,
        to: request.to,
        actor: "office",
        reason: request.reason,
      },
      createdAt: isoNow(deps.clock),
    });
  }
  deps.write.logger.warn("transition.rejected", {
    repo: request.repo,
    issue: request.issue,
    from,
    to: request.to,
    reason: request.reason,
  });
}

/**
 * イシューの状態を `to` に変える。
 *
 * 遷移表にない変更は、例外ではなく結果(`rejected`)として返す。
 * 例外になるのは、イシューがDBにない場合と、GitHubへの書き込みに失敗した場合である。
 * 書き込みに失敗したときは、DBの状態を変えないので、もう一度呼べばやり直せる。
 */
export function applyTransition(
  deps: TransitionDeps,
  request: TransitionRequest,
): Promise<TransitionResult> {
  const { db, write } = deps;
  const { repo, issue, to } = request;
  return deps.locks.run(repo, async (): Promise<TransitionResult> => {
    const from = currentState(db, repo, issue);
    if (from === to) return { status: "unchanged" };
    if (!isIssueState(from) || !isTransitionAllowed(from, to, "office")) {
      recordRejection(deps, request, from);
      return {
        status: "rejected",
        from,
        reason: `遷移表にない変更です: ${from} → ${to}`,
      };
    }
    const written = await setStateLabel(write, repo, issue, { from, to });
    if (!written) return { status: "dry_run", from };
    db.prepare(
      "UPDATE issues SET state = ? WHERE repo = ? AND number = ? AND state = ?",
    ).run(to, repo, issue, from);
    if (from === "failed") {
      resetAttempts(db, deps.clock, { repo, issueNumber: issue });
    }
    write.logger.info("transition.applied", {
      repo,
      issue,
      from,
      to,
      reason: request.reason,
    });
    return { status: "applied", from };
  });
}
