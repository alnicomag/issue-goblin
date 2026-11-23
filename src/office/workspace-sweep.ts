/**
 * イシューの作業場所を、消すか残すかを決める。
 *
 * ここにある関数は純粋関数で、DBにもファイルにも触れない。入力は記録だけなので、
 * 何度行っても同じ答えが出る。消す操作そのものは `workspace.ts` の `cleanupWorkspace` が行う。
 *
 * PRを作った実行は、自分の cleanup のステップで作業場所を消す。ここで扱うのは、
 * そこに届かなかった作業場所(取り消し、失敗、質問、人間の対応待ちの後に残ったもの)である。
 */
import type { RunStatus } from "./runs.ts";

export interface SweepInput {
  /** DBにある、イシューの状態(GitHubの写し)。DBにないイシューなら null。 */
  readonly issueState: string | null;
  /** そのイシューの、すべての実行。 */
  readonly runs: readonly {
    readonly status: RunStatus;
    /** 終わった時刻(UTCのISO 8601)。終わっていなければ null。 */
    readonly finishedAt: string | null;
  }[];
  /** この事務局のプロセスが、そのイシューの実行をまだ進めているか(止めている途中を含む)。 */
  readonly active: boolean;
  /**
   * 人間が `failed` のイシューを戻した時刻のうち、最新のもの(同期が記録した
   * 「`failed` からの変更」のイベントの時刻)。なければ null。
   */
  readonly returnedFromFailedAt: string | null;
}

/**
 * - `keep`: 残す。
 * - `remove_closed`: イシューがクローズされたので、消す。
 * - `remove_returned`: 人間が `failed` のイシューを戻したので、消す。次の実行は、既定ブランチの最新から始まる。
 */
export type SweepDecision = "keep" | "remove_closed" | "remove_returned";

export function decideSweep(input: SweepInput): SweepDecision {
  const { issueState, runs, returnedFromFailedAt } = input;
  // 記録のないイシューの作業場所は、事務局が作ったものか分からないので、触らない。
  if (issueState === null) return "keep";
  // ワーカーが使っているかもしれない間は、消さない。
  // クローズを待っている実行(残りは cleanup だけ)も実行中なので、ここで残り、自分の cleanup で消す。
  if (input.active || runs.some((run) => run.status === "running")) {
    return "keep";
  }
  if (issueState === "closed") return "remove_closed";
  // 戻した時刻までに、すべての実行が終わっている場合だけ消す(試行回数のリセットと同じ区切り)。
  // 戻した後に始まった実行があれば、作業場所はその実行のものなので、残す。
  if (
    returnedFromFailedAt !== null &&
    runs.every(
      (run) =>
        run.finishedAt !== null && run.finishedAt <= returnedFromFailedAt,
    )
  ) {
    return "remove_returned";
  }
  // 失敗の後の再試行、質問、人間の対応待ち、人間のラベル変更による取り消しの後は、残す。
  return "keep";
}
