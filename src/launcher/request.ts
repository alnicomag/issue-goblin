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
/** イメージのビルドの、時間の上限。ステップの時間の上限とは別に数える。 */
export const BUILD_TIMEOUT_SEC = 30 * 60;
/** 1回の実行の、時間の上限の最大値。 */
export const MAX_TIMEOUT_SEC = 4 * 60 * 60;

/** 製品の Dockerfile の大きさの上限。 */
export const MAX_DOCKERFILE_BYTES = 64 * 1024;

/** 依頼で選べる、作業場所の種類。 */
export const WORKSPACE_KINDS = ["issue", "preflight"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

const Argument = z
  .string()
  .refine((value) => !value.includes("\0"), "NUL文字は使えません");

export const RunRequestSchema = z
  .strictObject({
    /** 対象のリポジトリ(owner/name)。設定にあるものだけを受け付ける。 */
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name の形式ではありません"),
    /**
     * マウントする作業場所の種類。パスは、起動係が自分で組み立てる。
     *
     * - `issue`: イシューの作業場所(リポジトリと `issue` から決まる)。
     * - `preflight`: 着手前の確認のための、製品ごとの作業場所(リポジトリだけから決まる)。
     */
    workspace: z.enum(WORKSPACE_KINDS).default("issue"),
    /**
     * イシュー番号。イシューの作業場所は、リポジトリとこの番号から起動係が決める。
     * `workspace` が `issue` のときは必ず指定し、`preflight` のときは指定しない。
     */
    issue: z.number().int().min(1).max(2_147_483_647).optional(),
    /** ワーカーのコンテナの中で実行するコマンド。 */
    argv: z.array(Argument).min(1).max(256),
    /** コマンドの標準入力に渡す文字列。 */
    stdin: z.string().default(""),
    /**
     * 製品の Dockerfile の本文(既定ブランチのもの)。省略すると、設定のイメージをそのまま使う。
     * 指定すると、起動係が検査してビルドし、できたイメージで実行する。イメージの名前は選べない。
     */
    dockerfile: z.string().min(1).optional(),
    /** Claudeのトークンを渡すか。Claudeを呼ぶステップだけ true にする。 */
    claude_token: z.boolean().default(false),
    /** この秒数を過ぎたら、コンテナごと止める。 */
    timeout_sec: z.number().int().min(1).max(MAX_TIMEOUT_SEC),
  })
  .superRefine((request, ctx) => {
    if (request.workspace === "issue" && request.issue === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["issue"],
        message: "イシューの作業場所には、イシュー番号が要ります",
      });
    }
    if (request.workspace === "preflight" && request.issue !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["issue"],
        message: "着手前の確認の作業場所には、イシュー番号を指定できません",
      });
    }
    if (
      request.dockerfile !== undefined &&
      Buffer.byteLength(request.dockerfile) > MAX_DOCKERFILE_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dockerfile"],
        message: `Dockerfile が大きすぎます(上限 ${MAX_DOCKERFILE_BYTES} バイト)`,
      });
    }
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
  /**
   * 製品の Dockerfile を添えた依頼での、イメージのビルドの結果。添えていなければ、項目がない。
   *
   * - `cached`: 同じ内容のイメージが手元にあったので、ビルドしなかった。
   * - `built`: ビルドした。
   * - `failed`: ビルドできなかった(検査に通らない、基本イメージがない、ビルドの失敗、時間切れ)。
   *   コマンドは実行していない。`exit_code` と `timed_out` はビルドのもので、理由と出力は `stderr` に入る。
   */
  build: z.enum(["cached", "built", "failed"]).optional(),
});

export type RunResult = z.infer<typeof RunResultSchema>;

/**
 * 製品用のイメージと、その土台(基本のイメージ)の関係。
 *
 * - `self`: 基本のイメージそのもの(設定の全体の `worker_image`)。
 * - `current`: いま手元にある基本を土台にしている(基本の層を、そのまま先頭に含む)。
 * - `stale`: いまの基本を土台にしていない(基本を作り直した後に、作り直していない。または、基本を土台にしていない)。
 * - `unknown`: 比べられない(このイメージか、基本が、手元にない)。
 */
export const IMAGE_BASES = ["self", "current", "stale", "unknown"] as const;
export type ImageBase = (typeof IMAGE_BASES)[number];

/**
 * ワーカーのイメージ1つの情報。
 *
 * - `configured`: 設定にあるイメージ(全体か、製品ごとの `worker_image`)。
 * - `built`: 起動係が、製品の Dockerfile からビルドしたイメージ。
 */
export const ImageInfoSchema = z.strictObject({
  kind: z.enum(["configured", "built"]),
  image: z.string(),
  /** このイメージを使う製品(設定にある書き方のリポジトリ名)。 */
  repos: z.array(z.string()),
  /** 手元にあるか。 */
  present: z.boolean(),
  /** 作った時刻(UTCのISO 8601形式)。手元にないか、読めなければ null。 */
  created: z.string().nullable(),
  /** 目印(作った元のコミット)。目印のないイメージと、手元にないイメージは null。 */
  revision: z.string().nullable(),
  base: z.enum(IMAGE_BASES),
});
export type ImageInfo = z.infer<typeof ImageInfoSchema>;

/** `GET /images` の応答。稼働中の起動係と、ワーカーのイメージが、どの目印のものかを表す。 */
export const ImagesReportSchema = z.strictObject({
  /** 起動係自身のイメージの目印。目印のないイメージでは null。 */
  revision: z.string().nullable(),
  /** 基本のイメージの名前(設定の全体の `worker_image`)。 */
  base_image: z.string(),
  images: z.array(ImageInfoSchema),
});
export type ImagesReport = z.infer<typeof ImagesReportSchema>;
