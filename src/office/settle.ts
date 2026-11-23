/**
 * 実行の記録とイシューの状態から、次に行うことを決める。
 *
 * ここにある関数は純粋関数で、DBにもネットワークにも触れない。
 * 入力は記録だけなので、事務局が途中で落ちても、起動し直せば同じ答えが出る。
 * 状態を進める処理をここから導くことで、「ステップは終わったが、ラベルを変える前に落ちた」
 * 場合にも、続きから進められる。
 */
import type { StepName } from "./run-steps.ts";
import type { RunStatus } from "./runs.ts";

export interface SettleInput {
  /** DBにある、イシューの状態(GitHubの写し)。 */
  readonly issueState: string;
  /** そのイシューの実行。実行中のものがあればそれ、なければ最新のもの。1つもなければ null。 */
  readonly run: {
    readonly status: RunStatus;
    /** 次に行うステップ。実行中でなければ null。 */
    readonly nextStep: StepName | null;
    /** ステップを1つでも始めたか。 */
    readonly started: boolean;
    /**
     * publish が人間の対応待ちで止まって終わった実行(`held`)の、止まり方。それ以外は省く。
     *
     * - `reason`: 止まった理由。記録から読めなければ null。
     * - `approval`: 止まったステップに対する承認の記録。`pending` は、記録したが、まだ再開していない。
     */
    readonly held?: {
      readonly reason: "needs_approval" | "forbidden" | null;
      readonly approval: "none" | "pending" | "used";
    };
  } | null;
  /** イシューに、承認のラベル(`agent:approved`)が付いているか(GitHubの写し)。 */
  readonly approvedLabel?: boolean;
  /** この事務局のプロセスが、その実行をいま進めているか。 */
  readonly active: boolean;
  /** 試行に数える失敗の数。 */
  readonly failedCount: number;
  /** 試行の上限(`limits.max_attempts`)。 */
  readonly maxAttempts: number;
}

/**
 * - `none`: 何もしない。
 * - `begin`: `in-progress` に進めてから、実行を進める(着手の続き)。
 * - `advance`: 実行を進める(再開、または cleanup)。
 * - `cancel`: 実行を取り消す。人間が状態を変えたので、GitHubに合わせる。
 * - `to_review`: PRができたので、`in-review` に進める。
 * - `ask`: 質問をコメントして、`needs-info` に進める。
 * - `hold`: publish が人間の対応待ちで止まったので、理由をコメントして、`needs-info` に進める。
 * - `approve`: 人間が承認したので、承認を記録し、ラベルを外し、`in-progress` に進めて、publish から再開する。
 * - `resume`: 承認を記録して `in-progress` に進めた後で止まっていたので、publish から再開する。
 * - `retry`: 失敗したが試行に余裕があるので、`ready` に戻す。
 * - `give_up`: 試行の上限に達したので、`failed` に進める。
 */
export type SettleAction =
  | "none"
  | "begin"
  | "advance"
  | "cancel"
  | "to_review"
  | "ask"
  | "hold"
  | "approve"
  | "resume"
  | "retry"
  | "give_up";

export function decideSettlement(input: SettleInput): SettleAction {
  const { issueState, run, active } = input;
  if (run === null) return "none";

  if (run.status === "running") {
    if (run.nextStep === "cleanup") {
      // publish まで終わっている。残りは、クローズの後の cleanup だけ。
      if (issueState === "in-progress") return "to_review";
      if (issueState === "in-review") return "none";
      if (issueState === "closed") return active ? "none" : "advance";
      return "cancel";
    }
    if (issueState === "in-progress") return active ? "none" : "advance";
    // 実行を記録した後、ラベルを変える前に止まった場合。
    if (issueState === "ready" && !run.started) {
      return active ? "none" : "begin";
    }
    // 事務局が進めている間の状態は in-progress だけ。それ以外は、人間が変えたもの。
    return "cancel";
  }

  // 実行は終わっている。
  // 保護対象のパスで止まり、needs-info で待っている実行は、人間の承認があれば再開する。
  // 承認として扱うのは、ラベルが付いている場合と、承認を記録した後で止まっていた場合である。
  // 禁止のパスで止まった実行と、理由を読めない実行は、ラベルがあっても進めない。
  if (issueState === "needs-info") {
    const held = run.status === "held" ? run.held : undefined;
    if (held?.reason !== "needs_approval") return "none";
    if (held.approval === "pending") return "approve";
    return held.approval === "none" && input.approvedLabel === true
      ? "approve"
      : "none";
  }
  // イシューが in-progress のままなら、終わり方に応じて状態を進める。
  if (issueState !== "in-progress") return "none";
  switch (run.status) {
    case "question":
      return "ask";
    case "failed":
      if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
        throw new Error(`試行の上限が不正です: ${String(input.maxAttempts)}`);
      }
      return input.failedCount >= input.maxAttempts ? "give_up" : "retry";
    case "held":
      // 承認を記録して in-progress に進めた後、再開の前に止まった場合は、続きを行う。
      return run.held?.approval === "pending" ? "resume" : "hold";
    case "done":
    case "cancelled":
      return "none";
  }
}
