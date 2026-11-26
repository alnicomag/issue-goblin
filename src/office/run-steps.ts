/**
 * 1回の実行の中での、ステップの進み方。
 *
 * ここにある関数は純粋関数で、DBにもネットワークにも触れない。
 * 入力は「実行の現在の状態と、直前のステップの結果」、出力は「次に行うこと」。
 */

/** ステップの並び。通常はこの順に進む。 */
export const STEP_NAMES = [
  "prepare",
  "plan",
  "implement",
  "verify",
  "review",
  "publish",
  "cleanup",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

/**
 * ステップの結果。
 *
 * - `done`: 終わった。次のステップへ進む。
 * - `rework`: 差し戻し(verify の失敗、review の修正要求)。implement に戻す。
 * - `question`: 質問を返して終了する。
 * - `failed`: ステップそのものが失敗した。実行を失敗で終える。
 * - `held`: 人間の対応待ちで終了する(publish が、禁止や保護対象のパスで止まった。または、
 *   prepare か publish が、リモートに残った別のファクトリーのブランチで止まった)。
 *   失敗ではないので、試行に数えず、再試行もしない。
 */
export const STEP_OUTCOMES = [
  "done",
  "rework",
  "question",
  "failed",
  "held",
] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** 1回の実行の中で、implement に差し戻せる回数。 */
export const MAX_REWORKS = 2;

/** 差し戻しを返せるステップ。 */
const REWORK_STEPS: readonly StepName[] = ["verify", "review"];
/** 質問を返せるステップ(Claudeが担当するもの)。 */
const QUESTION_STEPS: readonly StepName[] = ["plan", "implement", "review"];
/** 人間の対応待ちを返せるステップ。 */
const HELD_STEPS: readonly StepName[] = ["prepare", "publish"];

export interface RunProgress {
  /** 直前のステップの結果より前に、この実行で起きた差し戻しの回数。 */
  readonly reworkCount: number;
}

export interface StepResult {
  readonly step: StepName;
  readonly outcome: StepOutcome;
}

/** 実行の終わり方。取り消し(`cancelled`)は外から起きるので、ここには含めない。 */
export type FinishStatus = "done" | "question" | "failed" | "held";

export type NextAction =
  | { readonly kind: "run_step"; readonly step: StepName }
  | { readonly kind: "finish"; readonly status: FinishStatus };

/**
 * 次に行うことを決める。
 *
 * `last` が null なら、まだどのステップも終わっていない。
 * あり得ない組み合わせ(prepare が差し戻しを返すなど)は、エラーにする。
 */
export function nextAction(
  progress: RunProgress,
  last: StepResult | null,
): NextAction {
  if (!Number.isInteger(progress.reworkCount) || progress.reworkCount < 0) {
    throw new Error(
      `差し戻しの回数が不正です: ${String(progress.reworkCount)}`,
    );
  }
  if (last === null) {
    return { kind: "run_step", step: "prepare" };
  }

  switch (last.outcome) {
    case "done": {
      const next = STEP_NAMES[STEP_NAMES.indexOf(last.step) + 1];
      return next === undefined
        ? { kind: "finish", status: "done" }
        : { kind: "run_step", step: next };
    }
    case "rework":
      if (!REWORK_STEPS.includes(last.step)) {
        throw new Error(`${last.step} は差し戻しを返せません`);
      }
      return progress.reworkCount >= MAX_REWORKS
        ? { kind: "finish", status: "failed" }
        : { kind: "run_step", step: "implement" };
    case "question":
      if (!QUESTION_STEPS.includes(last.step)) {
        throw new Error(`${last.step} は質問を返せません`);
      }
      return { kind: "finish", status: "question" };
    case "failed":
      return { kind: "finish", status: "failed" };
    case "held":
      if (!HELD_STEPS.includes(last.step)) {
        throw new Error(`${last.step} は人間の対応待ちを返せません`);
      }
      return { kind: "finish", status: "held" };
  }
}

/**
 * 失敗の後に待つ時間(分)。
 *
 * `failedCount` は、そのイシューで `failed` に終わった実行の数(今回を含む)。
 * 回数が `waits` の長さを超えたら、最後の値を使う。
 */
export function retryWaitMinutes(
  failedCount: number,
  waits: readonly number[],
): number {
  if (!Number.isInteger(failedCount) || failedCount < 1) {
    throw new Error(`失敗の回数が不正です: ${String(failedCount)}`);
  }
  const wait = waits[Math.min(failedCount, waits.length) - 1];
  if (wait === undefined) {
    throw new Error("待機時間が1つも設定されていません");
  }
  return wait;
}

/** 次に再試行してよい時刻(UTCのISO 8601形式)。 */
export function nextRetryAt(
  finishedAt: Date,
  failedCount: number,
  waits: readonly number[],
): string {
  const minutes = retryWaitMinutes(failedCount, waits);
  return new Date(finishedAt.getTime() + minutes * 60_000).toISOString();
}
