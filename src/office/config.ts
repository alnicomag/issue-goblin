import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** 設定ファイルの場所。環境変数 FACTORY_CONFIG で変えられる。 */
export const DEFAULT_CONFIG_PATH = "config/factory.config.yml";

/** Dockerのイメージ名。引数として渡すので、オプションに見える書き方を通さない。 */
const ImageName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._/:@-]*$/,
    "イメージ名を書いてください(英小文字と数字で始める)",
  );

/** 置き場所のディレクトリ。相対パスは、実行する場所で意味が変わるので通さない。 */
const AbsoluteDir = z
  .string()
  .refine((value) => path.isAbsolute(value), "絶対パスで書いてください")
  .transform((value) => path.resolve(value));

/** `child` が `parent` と同じか、その内側にあるか。どちらも絶対パスで渡す。 */
export function isInsideDir(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** コミットの作者の既定値。メールアドレスは、実在の宛先に届かない予約済みのドメインにする。 */
const DEFAULT_AUTHOR_NAME = "factory-worker";
const DEFAULT_AUTHOR_EMAIL = "factory-worker@example.invalid";

/**
 * ワーカーのコミットの作者。作業場所のcloneのgit設定に書く。
 * gitが作者の区切りに使う文字(`<`、`>`、改行)は通さない。
 */
const CommitAuthorSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[^<>\r\n]*[^<>\s][^<>\r\n]*$/,
      "空ではない名前を書いてください(<、>、改行は使えません)",
    )
    .default(DEFAULT_AUTHOR_NAME),
  email: z
    .string()
    .regex(
      /^[^<>@\s]+@[^<>@\s]+$/,
      "メールアドレスを書いてください(<、>、空白は使えません)",
    )
    .default(DEFAULT_AUTHOR_EMAIL),
});

const RepoConfigSchema = z.strictObject({
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name の形式で書いてください")
    // リポジトリ名は作業場所のパスに使うので、置き場所の外を指す書き方を通さない。
    .refine(
      (value) =>
        value.split("/").every((part) => part !== "." && part !== ".."),
      "owner と name に . や .. は使えません",
    ),
  token_env: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "環境変数の名前を書いてください(トークンそのものは書かない)",
    ),
  /** この製品のワーカーに使うイメージ。省略すると、全体の `worker_image` を使う。 */
  worker_image: ImageName.optional(),
});

const FactoryConfigSchema = z
  .strictObject({
    dry_run: z.boolean().default(true),
    poll_interval_sec: z.number().int().min(1).default(60),
    db_path: z.string().min(1),
    /** 事務局専用のミラーの置き場所。ワーカーには見せない。 */
    repos_dir: AbsoluteDir,
    /** イシューごとの作業場所の置き場所。ワーカーには、このうち1件分だけを見せる。 */
    work_dir: AbsoluteDir,
    /**
     * ワーカーの呼び出しのログの置き場所。事務局だけが読み書きする。
     * ワーカーに書き換えられないように、作業場所の外に置く。
     */
    logs_dir: AbsoluteDir.default("/data/logs"),
    /** ワーカーの既定のイメージ。 */
    worker_image: ImageName.default("factory-worker"),
    /**
     * 失敗した後に、再試行まで待つ時間(分)。
     * 1回目の失敗の後は1つ目、2回目の後は2つ目を使い、回数が足りなければ最後の値を使う。
     */
    retry_wait_minutes: z
      .array(z.number().int().min(0))
      .min(1, "待機時間を1つ以上書いてください")
      .default([5, 30, 120]),
    /** ワーカーのコミットの作者。全製品で同じものを使う。 */
    commit_author: CommitAuthorSchema.default({
      name: DEFAULT_AUTHOR_NAME,
      email: DEFAULT_AUTHOR_EMAIL,
    }),
    repos: z.array(RepoConfigSchema).min(1),
  })
  .superRefine((config, ctx) => {
    // ミラーが作業場所の内側にあると、ワーカーから見える場所に入りうる。
    // 逆向きでも、片方の後片付けがもう片方を消しうるので、どちらも通さない。
    if (isInsideDir(config.work_dir, config.repos_dir)) {
      ctx.addIssue({
        code: "custom",
        path: ["repos_dir"],
        message: `work_dir(${config.work_dir})の外に置いてください`,
      });
    } else if (isInsideDir(config.repos_dir, config.work_dir)) {
      ctx.addIssue({
        code: "custom",
        path: ["work_dir"],
        message: `repos_dir(${config.repos_dir})の外に置いてください`,
      });
    }
    // ログは、ワーカーから見える場所(作業場所)にも、ミラーの中にも置かない。
    for (const [name, dir] of [
      ["work_dir", config.work_dir],
      ["repos_dir", config.repos_dir],
    ] as const) {
      if (
        isInsideDir(dir, config.logs_dir) ||
        isInsideDir(config.logs_dir, dir)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["logs_dir"],
          message: `${name}(${dir})と重ならない場所に置いてください`,
        });
      }
    }
    const seen = new Set<string>();
    config.repos.forEach((entry, index) => {
      const key = entry.repo.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", index, "repo"],
          message: `同じリポジトリが2回書かれています: ${entry.repo}`,
        });
      }
      seen.add(key);
    });
  });

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type CommitAuthor = z.infer<typeof CommitAuthorSchema>;
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

/** zodのエラーを「項目名: 内容」の行に直す。 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(全体)";
      return `  ${where}: ${issue.message}`;
    })
    .join("\n");
}

/** YAMLの文字列を設定として検証する。不正なら項目名の分かるメッセージで失敗する。 */
export function parseConfig(text: string, source = "設定"): FactoryConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`${source} をYAMLとして読めません`, { cause: error });
  }
  const result = FactoryConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${source} の内容が不正です:\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function loadConfig(path: string): FactoryConfig {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `設定ファイルを読めません: ${path}(config/factory.config.example.yml を複製して作ってください)`,
      { cause: error },
    );
  }
  return parseConfig(text, path);
}

/** リポジトリのワーカーに使うイメージ。設定にないリポジトリなら失敗する。 */
export function workerImageFor(config: FactoryConfig, repo: string): string {
  const entry = config.repos.find(
    (candidate) => candidate.repo.toLowerCase() === repo.toLowerCase(),
  );
  if (entry === undefined) {
    throw new Error(`設定にないリポジトリです: ${repo}`);
  }
  return entry.worker_image ?? config.worker_image;
}

/**
 * リポジトリのトークンを環境変数から読む。
 * 値はここから呼び出し元に返すだけで、ログにもDBにも書かない。
 */
export function resolveToken(
  repo: RepoConfig,
  env: Record<string, string | undefined>,
): string {
  const token = env[repo.token_env];
  if (token === undefined || token.trim() === "") {
    throw new Error(
      `${repo.repo} のトークンがありません。環境変数 ${repo.token_env} を設定してください`,
    );
  }
  return token.trim();
}
