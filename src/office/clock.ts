/** 時計。テストで差し替えられるように、インターフェース越しに注入する。 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** UTCのISO 8601形式の文字列(例: 2026-01-02T03:04:05.678Z)。 */
export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}
