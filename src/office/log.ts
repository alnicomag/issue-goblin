import { type Clock, systemClock } from "./clock.ts";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

/** 構造化ログ。1行1件のJSONで出す。 */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(
  options: { write?: (line: string) => void; clock?: Clock } = {},
): Logger {
  const write =
    options.write ?? ((line: string) => void process.stdout.write(line));
  const clock = options.clock ?? systemClock;
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    write(
      `${JSON.stringify({ time: clock.now().toISOString(), level, event, ...fields })}\n`,
    );
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

/** 何も出さないログ。テスト用。 */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * 例外をログ用の項目に直す。
 * 例外オブジェクトをそのまま出すと、HTTPのリクエスト情報(認証ヘッダーなど)が
 * 混ざりうるので、メッセージと種類だけを取り出す。
 */
export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }
  const fields: LogFields = { error: error.message, error_name: error.name };
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") fields.status = status;
  if (error.cause !== undefined) {
    fields.cause =
      error.cause instanceof Error ? error.cause.message : String(error.cause);
  }
  return fields;
}
