import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** 設定ファイルの場所。環境変数 FACTORY_CONFIG で変えられる。 */
export const DEFAULT_CONFIG_PATH = "config/factory.config.yml";

const RepoConfigSchema = z.strictObject({
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name の形式で書いてください"),
  token_env: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "環境変数の名前を書いてください(トークンそのものは書かない)",
    ),
});

const FactoryConfigSchema = z
  .strictObject({
    dry_run: z.boolean().default(true),
    poll_interval_sec: z.number().int().min(1).default(60),
    db_path: z.string().min(1),
    repos: z.array(RepoConfigSchema).min(1),
  })
  .superRefine((config, ctx) => {
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
