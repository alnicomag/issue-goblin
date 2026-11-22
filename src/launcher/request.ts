/**
 * 起動係が受け付ける依頼の形と、その検査。DBにもネットワークにも触れない。
 *
 * 事務局が起動係に頼めるのは、ここにある項目だけである。
 * マウントするパス、イメージ、ネットワーク、権限は、依頼では指定できない。
 */
import { z } from "zod";
import { formatZodError } from "../office/config.ts";

/** 標準入力として渡せる大きさの上限(指示書と入力を合わせたもの)。 */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;
/** 引数全体の大きさの上限。 */
export const MAX_ARGV_BYTES = 128 * 1024;
/** 1回の実行の、時間の上限の最大値。 */
export const MAX_TIMEOUT_SEC = 4 * 60 * 60;

const Argument = z
  .string()
  .refine((value) => !value.includes("\0"), "NUL文字は使えません");

export const RunRequestSchema = z
  .strictObject({
    /** 対象のリポジトリ(owner/name)。設定にあるものだけを受け付ける。 */
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name の形式ではありません"),
    /** イシュー番号。作業場所は、リポジトリとこの番号から起動係が決める。 */
    issue: z.number().int().min(1).max(2_147_483_647),
    /** ワーカーのコンテナの中で実行するコマンド。 */
    argv: z.array(Argument).min(1).max(256),
    /** コマンドの標準入力に渡す文字列。 */
    stdin: z.string().default(""),
    /** Claudeのトークンを渡すか。Claudeを呼ぶステップだけ true にする。 */
    claude_token: z.boolean().default(false),
    /** この秒数を過ぎたら、コンテナごと止める。 */
    timeout_sec: z.number().int().min(1).max(MAX_TIMEOUT_SEC),
  })
  .superRefine((request, ctx) => {
    if (Buffer.byteLength(request.stdin) > MAX_STDIN_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["stdin"],
        message: `標準入力が大きすぎます(上限 ${MAX_STDIN_BYTES} バイト)`,
      });
    }
    const argvBytes = request.argv.reduce(
      (sum, value) => sum + Buffer.byteLength(value) + 1,
      0,
    );
    if (argvBytes > MAX_ARGV_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["argv"],
        message: `引数が大きすぎます(上限 ${MAX_ARGV_BYTES} バイト)`,
      });
    }
  });

export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRequestInput = z.input<typeof RunRequestSchema>;

export type RunRequestParseResult =
  | { readonly ok: true; readonly value: RunRequest }
  | { readonly ok: false; readonly error: string };

/** 依頼を検査する。形式に合わなければ、項目名の分かるメッセージを返す。 */
export function parseRunRequest(raw: unknown): RunRequestParseResult {
  const result = RunRequestSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: `依頼の形式が不正です:\n${formatZodError(result.error)}`,
    };
  }
  return { ok: true, value: result.data };
}

/** 起動係が返す結果。 */
export const RunResultSchema = z.strictObject({
  /** コマンドの終了コード。シグナルで終わった場合や、起動できなかった場合は null。 */
  exit_code: z.number().int().nullable(),
  /** 時間の上限で止めた場合は true。 */
  timed_out: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  /** 出力が上限を超えて、途中で切られた場合は true。 */
  truncated: z.boolean(),
});

export type RunResult = z.infer<typeof RunResultSchema>;
