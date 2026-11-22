/**
 * Claudeの呼び出しの、入出力の形。
 *
 * Claudeの出力は外部からの入力なので、ここのスキーマで検証してから使う。
 */
import { z } from "zod";

/**
 * ワーカーが返せる状態。
 *
 * - `done`: 頼まれたことを終えた。
 * - `question`: 人間に聞かないと進められない。要約に質問を書く。
 * - `failed`: 終えられなかった。要約に理由を書く。
 */
export const WORKER_STATUSES = ["done", "question", "failed"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** ワーカーが返す結果。 */
export const WorkerOutputSchema = z.strictObject({
  status: z.enum(WORKER_STATUSES),
  summary: z.string().trim().min(1, "要約が空です"),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

/**
 * `--json-schema` に渡す、結果の形。`WorkerOutputSchema` と同じ内容にする
 * (食い違っていないことは、テストで確かめる)。
 */
export const WORKER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: [...WORKER_STATUSES] },
    summary: { type: "string", minLength: 1 },
  },
  required: ["status", "summary"],
  additionalProperties: false,
} as const;

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
