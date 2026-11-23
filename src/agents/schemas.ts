/**
 * Claudeの呼び出しの、入出力の形。
 *
 * Claudeの出力は外部からの入力なので、ここのスキーマで検証してから使う。
 */
import { z } from "zod";

/**
 * ワーカーが返せる状態。
 *
 * - `done`: 頼まれたことを終えた(review では、合格)。
 * - `rework`: 修正が要る。要約に指摘を書く。返せるのは review だけである。
 * - `question`: 人間に聞かないと進められない。要約に質問を書く。
 * - `failed`: 終えられなかった。要約に理由を書く。
 */
export const WORKER_STATUSES = [
  "done",
  "rework",
  "question",
  "failed",
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** どの指示書でも返せる状態。 */
const COMMON_STATUSES = ["done", "question", "failed"] as const;

/** 差し戻し(`rework`)を返せる指示書。 */
const REWORK_PROMPTS: readonly string[] = ["review"];

/**
 * 指示書ごとの、返せる状態。指示書に書く状態の一覧は、これと一致させる
 * (食い違っていないことは、テストで確かめる)。
 */
export function allowedStatuses(prompt: string): readonly WorkerStatus[] {
  return REWORK_PROMPTS.includes(prompt) ? WORKER_STATUSES : COMMON_STATUSES;
}

/** ワーカーが返す結果。 */
export const WorkerOutputSchema = z.strictObject({
  status: z.enum(WORKER_STATUSES),
  summary: z.string().trim().min(1, "要約が空です"),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

/**
 * `--json-schema` に渡す、結果の形。`WorkerOutputSchema` と同じ内容で、
 * 状態だけを、その指示書で返せるものに絞る(食い違っていないことは、テストで確かめる)。
 */
export function workerOutputJsonSchema(statuses: readonly WorkerStatus[]) {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: [...statuses] },
      summary: { type: "string", minLength: 1 },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  } as const;
}

/**
 * `claude -p --output-format json` が標準出力に書く、1件のJSON。
 * 使う項目だけを検証し、ほかの項目は読み捨てる(版が上がると項目が増えるため)。
 */
export const ClaudeResultSchema = z.object({
  type: z.literal("result"),
  /** `success` のほか、`error_max_turns` など。 */
  subtype: z.string(),
  is_error: z.boolean(),
  session_id: z.string().min(1).optional(),
  /** 定価で計算した金額。サブスクリプションでは請求額ではない。 */
  total_cost_usd: z.number().nonnegative().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  /** `--json-schema` に合わせて返された結果。 */
  structured_output: z.unknown().optional(),
  /** 失敗の理由。 */
  errors: z.array(z.string()).optional(),
  /** 最後の発言の文章。失敗の理由が入ることがある。 */
  result: z.string().optional(),
});
export type ClaudeResult = z.infer<typeof ClaudeResultSchema>;
