/**
 * ワーカー(plan、implement、review)の呼び出し。
 *
 * 事務局は、指示書と入力を渡し、決まった形式の結果を受け取る。
 * ステップを進める側は `WorkerInvoker` だけを見る。テストでは、偽の実装に差し替える。
 */
import type { RunResult } from "../launcher/request.ts";
import { formatZodError } from "../office/config.ts";
import {
  ClaudeResultSchema,
  WorkerOutputSchema,
  type WorkerStatus,
} from "./schemas.ts";

/** 失敗の理由に載せる、標準エラーや発言の長さの上限(文字数)。 */
const MAX_DETAIL_CHARS = 2000;

/**
 * Claudeのトークンに見える文字列を伏せる。
 *
 * 事務局はトークンの値を持たないので、値の照合ではなく、書き方(`sk-ant-` で始まる)で見つける。
 * ワーカーは自分のトークンを出力に書けるので、ログや記録に残す前に必ず通す。
 */
export function maskSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
}

/** 起動係の結果を解釈したもの。 */
export interface WorkerOutcome {
  readonly status: WorkerStatus;
  /** ワーカーの要約。事務局が `failed` にした場合は、その理由。 */
  readonly summary: string;
  /** Claude Codeのセッション。読み取れなかった場合は null。 */
  readonly sessionId: string | null;
  /**
   * `claude -p` が返した金額(米ドル)。読み取れなかった場合は null。
   * サブスクリプションでは請求額ではなく、定価で計算した参考値である。
   */
  readonly costUsd: number | null;
  /** 使ったターン数。読み取れなかった場合は null。 */
  readonly numTurns: number | null;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_DETAIL_CHARS
    ? trimmed
    : `…${trimmed.slice(-MAX_DETAIL_CHARS)}`;
}

function withDetail(message: string, detail: string | undefined): string {
  const text = detail === undefined ? "" : tail(detail);
  return text === "" ? message : `${message}: ${text}`;
}

/**
 * 起動係が返した実行結果を、ワーカーの結果として解釈する純粋関数。
 *
 * 形式に合わない出力、時間切れ、ターン数の上限は、理由の分かる要約を付けて `failed` にする。
 * 例外は投げない。
 */
export function interpretRun(
  run: RunResult,
  limits: { timeoutSec: number },
): WorkerOutcome {
  const failed = (
    summary: string,
    known: Partial<WorkerOutcome> = {},
  ): WorkerOutcome => ({
    sessionId: null,
    costUsd: null,
    numTurns: null,
    ...known,
    status: "failed",
    summary: maskSecrets(summary),
  });

  if (run.timed_out) {
    return failed(
      `時間の上限(${limits.timeoutSec}秒)に達したので、ワーカーを止めました`,
    );
  }
  if (run.truncated) {
    return failed("ワーカーの出力が大きすぎて、途中で切られました");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(run.stdout);
  } catch {
    if (run.exit_code !== 0) {
      return failed(
        withDetail(
          `claude が失敗しました(終了コード ${String(run.exit_code)})`,
          run.stderr,
        ),
      );
    }
    return failed(
      withDetail("ワーカーの出力をJSONとして読めません", run.stdout),
    );
  }

  const envelope = ClaudeResultSchema.safeParse(raw);
  if (!envelope.success) {
    return failed(
      `claude の出力の形式が不正です:\n${formatZodError(envelope.error)}`,
    );
  }
  const result = envelope.data;
  const known = {
    sessionId: result.session_id ?? null,
    costUsd: result.total_cost_usd ?? null,
    numTurns: result.num_turns ?? null,
  };

  if (result.subtype === "error_max_turns") {
    return failed(
      withDetail(
        "ターン数の上限に達したので、ワーカーが止まりました",
        result.errors?.join(" / "),
      ),
      known,
    );
  }
  if (result.is_error || result.subtype !== "success") {
    return failed(
      withDetail(
        `claude が失敗を返しました(${result.subtype})`,
        result.errors?.join(" / ") ?? result.result,
      ),
      known,
    );
  }
  if (run.exit_code !== 0) {
    return failed(
      withDetail(
        `claude が失敗しました(終了コード ${String(run.exit_code)})`,
        run.stderr,
      ),
      known,
    );
  }
  if (result.structured_output === undefined) {
    return failed(
      withDetail(
        "ワーカーが、決まった形式の結果(structured_output)を返しませんでした",
        result.result,
      ),
      known,
    );
  }

  const output = WorkerOutputSchema.safeParse(result.structured_output);
  if (!output.success) {
    return failed(
      `ワーカーの結果の形式が不正です:\n${formatZodError(output.error)}`,
      known,
    );
  }
  return {
    ...known,
    status: output.data.status,
    summary: maskSecrets(output.data.summary),
  };
}
