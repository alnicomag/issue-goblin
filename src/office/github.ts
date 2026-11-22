/**
 * GitHubクライアント。GitHubとの読み書きは、すべてこのファイルを通す。
 *
 * - `GitHubApi` は通信の口。同期の処理にはこれを注入し、テストでは偽の実装に差し替える。
 * - GitHubへの書き込みは、このファイルの書き込み関数(`addLabels`)だけが行う。
 *   書き込み関数は必ず `dry_run` を確認し、`true` なら通信せずにログだけを出す。
 */
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { formatZodError } from "./config.ts";
import type { Logger } from "./log.ts";

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
  readonly labels: readonly string[];
  readonly author: string | null;
  /** UTCのISO 8601形式(ミリ秒つき)。 */
  readonly updatedAt: string;
  readonly isPullRequest: boolean;
}

export interface GitHubComment {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly author: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** プルリクエストに付いたコメントか。 */
  readonly onPullRequest: boolean;
}

export type GitHubFileResult =
  | { readonly status: "found"; readonly sha: string; readonly content: string }
  | { readonly status: "unchanged" }
  | { readonly status: "missing" };

/** GitHubとの通信の口。1つのインスタンスが1つのトークンに対応する。 */
export interface GitHubApi {
  /** `since` 以降に更新されたイシュー(オープンとクローズの両方。プルリクエストも含む)。 */
  listIssues(repo: string, since: string | null): Promise<GitHubIssue[]>;
  /** `since` 以降に更新されたイシューコメント。 */
  listIssueComments(
    repo: string,
    since: string | null,
  ): Promise<GitHubComment[]>;
  /**
   * 既定ブランチにあるファイルを取得する。
   * `knownSha` と内容が同じだと分かった場合は、本文を取得せずに `unchanged` を返してよい。
   */
  getFile(
    repo: string,
    path: string,
    knownSha: string | null,
  ): Promise<GitHubFileResult>;
  /** 書き込み。直接呼ばず、必ず下の `addLabels` を通す。 */
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// 書き込み(ここだけ)
// ---------------------------------------------------------------------------

export interface WriteContext {
  readonly api: GitHubApi;
  readonly dryRun: boolean;
  readonly logger: Logger;
}

/**
 * イシューにラベルを付ける。
 * `dry_run` が `true` のときは通信せず、付ける予定だったことをログに出して `false` を返す。
 */
export async function addLabels(
  ctx: WriteContext,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<boolean> {
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", {
      reason: "dry_run",
      action: "add_labels",
      repo,
      issue: issueNumber,
      labels,
    });
    return false;
  }
  await ctx.api.addLabels(repo, issueNumber, labels);
  ctx.logger.info("github.write", {
    action: "add_labels",
    repo,
    issue: issueNumber,
    labels,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Octokitによる実装
// ---------------------------------------------------------------------------

/** GitHubの日時を、ミリ秒つきのUTCのISO 8601形式に揃える。 */
const Timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const UserSchema = z.object({ login: z.string() }).nullish();

const IssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  labels: z.array(
    z.union([z.string(), z.object({ name: z.string().nullish() })]),
  ),
  user: UserSchema,
  updated_at: Timestamp,
  pull_request: z.unknown().optional(),
});

const CommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullish(),
  user: UserSchema,
  created_at: Timestamp,
  updated_at: Timestamp,
  issue_url: z.string(),
  html_url: z.string(),
});

const FileSchema = z.object({
  type: z.literal("file"),
  sha: z.string(),
  encoding: z.literal("base64"),
  content: z.string(),
});

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `GitHubの応答(${what})が想定と違います:\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(
      `リポジトリは owner/name の形式で指定してください: ${repo}`,
    );
  }
  return { owner, repo: name };
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** GitHubの `since` に渡す形式(秒までのISO 8601)に直す。 */
function sinceParam(since: string | null): { since?: string } {
  if (since === null) return {};
  return { since: since.replace(/\.\d+Z$/, "Z") };
}

/** Octokitが失敗したリクエストごとに出す記録(例: `GET /path - 404 with id ... in 12ms`)。 */
const REQUEST_LOG_PATTERN = /^[A-Z]+ \S+ - \d{3} with id /;

const ThrottledOctokit = Octokit.plugin(throttling);

export function createOctokitApi(options: {
  token: string;
  logger: Logger;
}): GitHubApi {
  const { logger } = options;
  const octokit = new ThrottledOctokit({
    auth: options.token,
    // Octokit自身の出力も、1行1件のJSONに揃える。
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => logger.warn("github.client", { message }),
      error: (message: string) => {
        // 失敗したリクエストの記録。失敗は呼び出し側が文脈つきでログに出す。
        // また、304(変更なし)と404(ファイルなし)は、失敗ではなく通常の応答として扱う。
        if (REQUEST_LOG_PATTERN.test(message)) return;
        logger.error("github.client", { message });
      },
    },
    // レート制限に達したら、解除時刻まで待ってからやり直す。
    throttle: {
      onRateLimit: (retryAfter, request) => {
        logger.warn("github.rate_limited", {
          kind: "primary",
          retry_after_sec: retryAfter,
          method: request.method,
          url: request.url,
        });
        return true;
      },
      onSecondaryRateLimit: (retryAfter, request) => {
        logger.warn("github.rate_limited", {
          kind: "secondary",
          retry_after_sec: retryAfter,
          method: request.method,
          url: request.url,
        });
        return true;
      },
    },
  });

  // 条件付きリクエスト用のETag。プロセス内だけで持つ。
  const fileEtags = new Map<string, { etag: string; sha: string }>();

  return {
    async listIssues(repo, since) {
      const items = await octokit.paginate(octokit.rest.issues.listForRepo, {
        ...splitRepo(repo),
        state: "all",
        sort: "updated",
        direction: "asc",
        per_page: 100,
        ...sinceParam(since),
      });
      return items.map((item) => {
        const issue = parseResponse(IssueSchema, item, `${repo} のイシュー`);
        return {
          number: issue.number,
          title: issue.title,
          open: issue.state === "open",
          labels: issue.labels
            .map((label) => (typeof label === "string" ? label : label.name))
            .filter((name): name is string => typeof name === "string"),
          author: issue.user?.login ?? null,
          updatedAt: issue.updated_at,
          isPullRequest: issue.pull_request != null,
        };
      });
    },

    async listIssueComments(repo, since) {
      const items = await octokit.paginate(
        octokit.rest.issues.listCommentsForRepo,
        {
          ...splitRepo(repo),
          sort: "updated",
          direction: "asc",
          per_page: 100,
          ...sinceParam(since),
        },
      );
      return items.map((item) => {
        const comment = parseResponse(
          CommentSchema,
          item,
          `${repo} のコメント`,
        );
        const match = /\/issues\/(\d+)$/.exec(comment.issue_url);
        if (!match?.[1]) {
          throw new Error(
            `コメント ${comment.id} のイシュー番号を読めません: ${comment.issue_url}`,
          );
        }
        return {
          id: comment.id,
          issueNumber: Number.parseInt(match[1], 10),
          body: comment.body ?? "",
          author: comment.user?.login ?? null,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          onPullRequest: /\/pull\/\d+#/.test(comment.html_url),
        };
      });
    },

    async getFile(repo, path, knownSha) {
      const key = `${repo}:${path}`;
      const cached = fileEtags.get(key);
      const useEtag =
        cached !== undefined && knownSha !== null && cached.sha === knownSha;
      try {
        const response = await octokit.rest.repos.getContent({
          ...splitRepo(repo),
          path,
          ...(useEtag ? { headers: { "if-none-match": cached.etag } } : {}),
        });
        const result = FileSchema.safeParse(response.data);
        if (!result.success) {
          throw new Error(
            `${repo} の ${path} をファイルとして取得できません(ディレクトリ、または大きすぎるファイル)`,
          );
        }
        const etag = response.headers.etag;
        if (etag) {
          fileEtags.set(key, { etag, sha: result.data.sha });
        }
        return {
          status: "found",
          sha: result.data.sha,
          content: Buffer.from(result.data.content, "base64").toString("utf8"),
        };
      } catch (error) {
        if (statusOf(error) === 304) return { status: "unchanged" };
        if (statusOf(error) === 404) {
          fileEtags.delete(key);
          return { status: "missing" };
        }
        throw error;
      }
    },

    async addLabels(repo, issueNumber, labels) {
      await octokit.rest.issues.addLabels({
        ...splitRepo(repo),
        issue_number: issueNumber,
        labels,
      });
    },
  };
}
