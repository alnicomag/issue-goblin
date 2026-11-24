/**
 * ステップごとの上限(時間とターン数)の型と、既定値。
 *
 * 設定(`config.ts`)と実行(`runner.ts`)の両方が使うので、どちらにも依存しない場所に置く。
 */

/** Claudeのステップ1回の上限。 */
export interface ClaudeLimit {
  readonly timeoutSec: number;
  readonly maxTurns: number;
}

/** ステップごとの上限。 */
export interface StepLimits {
  readonly plan: ClaudeLimit;
  readonly implement: ClaudeLimit;
  readonly review: ClaudeLimit;
  /** 検査コマンド1つごとの時間の上限(秒)。 */
  readonly verifyTimeoutSec: number;
}

/** 上限の既定値。設定(`step_limits`)で省略した項目にも、この値を使う。 */
export const DEFAULT_STEP_LIMITS: StepLimits = {
  plan: { timeoutSec: 30 * 60, maxTurns: 50 },
  implement: { timeoutSec: 2 * 60 * 60, maxTurns: 200 },
  review: { timeoutSec: 30 * 60, maxTurns: 50 },
  verifyTimeoutSec: 30 * 60,
};
