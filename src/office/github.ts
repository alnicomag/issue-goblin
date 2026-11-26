/**
 * GitHubクライアント。GitHubとの読み書きは、すべてこのファイルを通す。
 *
 * - `GitHubApi` は通信の口。同期の処理にはこれを注入し、テストでは偽の実装に差し替える。
 * - GitHubへの書き込みは、このファイルの書き込み関数(`addLabels`、`setStateLabel`、`pushBranch`、
 *   `createPullRequest`、`updatePullRequest`、`addIssueComment`)だけが行う。
 *   書き込み関数は必ず `dry_run` を確認し、`true` なら通信せずにログだけを出す。
 * - push はgitで行うが、GitHubへの書き込みなので、ここに置く。
 * - `main` へのマージを行う口は、作らない。マージは人間だけが行う。
 */
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { formatZodError } from "./config.ts";
import type { Git } from "./git.ts";
import type { Logger } from "./log.ts";
import type { IssueState } from "./transitions.ts";

/** エージェントが書いたコメントとPRに付ける目印。人間の書き込みと見分ける。 */
export const FACTORY_MARKER = "<!-- factory -->";

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  /** 本文。ないときは空文字。 */
  readonly body: string;
  readonly open: boolean;
  readonly labels: readonly string[];
  readonly author: string | null;
  /** 担当者(assignee)のログイン名。いなければ空。 */
  readonly assignees: readonly string[];
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

export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
}

/** PRのレビュー1件。 */
export interface GitHubReview {
  readonly id: number;
  readonly author: string | null;
  /** GitHubの状態(`APPROVED`、`CHANGES_REQUESTED`、`COMMENTED`、`DISMISSED`、`PENDING`)。 */
  readonly state: string;
  /** 本文。ないときは空文字。 */
  readonly body: string;
  /** レビューの対象のコミット。分からなければ null。 */
  readonly commitId: string | null;
  /** 出された時刻(UTCのISO 8601形式)。出される前(`PENDING`)は null。 */
  readonly submittedAt: string | null;
}

/** レビューに付いた、行ごとのコメント1件。 */
export interface GitHubReviewComment {
  readonly id: number;
  readonly path: string;
  /** コメントの付いた行。行に結び付かない場合(ファイル全体、古くなった位置)は null。 */
  readonly line: number | null;
  readonly body: string;
}

export interface PullRequestContent {
  readonly title: string;
  readonly body: string;
}

export interface NewPullRequest extends PullRequestContent {
  /** PRにするブランチ(同じリポジトリの中のもの)。 */
  readonly head: string;
  /** 取り込み先のブランチ。 */
  readonly base: string;
}

export type GitHubFileResult =
  | { readonly status: "found"; readonly sha: string; readonly content: string }
  | { readonly status: "unchanged" }
  | { readonly status: "missing" };

/** GitHubとの通信の口。1つのインスタンスが1つのトークンに対応する。 */
export interface GitHubApi {
  /** このトークンの持ち主のログイン名。 */
  getAuthenticatedLogin(): Promise<string>;
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
  /** イシュー1件に付いたコメントのすべて(古い順)。 */
  listCommentsOnIssue(
    repo: string,
    issueNumber: number,
  ): Promise<GitHubComment[]>;
  /** ブランチ `head` から出ている、オープンなPR。なければ null。 */
  findOpenPullRequest(
    repo: string,
    head: string,
  ): Promise<GitHubPullRequest | null>;
  /** PRのレビューのすべて(古い順)。 */
  listPullRequestReviews(
    repo: string,
    prNumber: number,
  ): Promise<GitHubReview[]>;
  /** レビュー1件に付いた、行ごとのコメントのすべて。 */
  listReviewComments(
    repo: string,
    prNumber: number,
    reviewId: number,
  ): Promise<GitHubReviewComment[]>;
  /** イシューかPRの1件に、いま付いているラベルの名前。 */
  listLabelsOnIssue(repo: string, issueNumber: number): Promise<string[]>;
  /** 書き込み。直接呼ばず、必ず下の `addLabels` を通す。 */
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
  /**
   * 書き込み。直接呼ばず、必ず下の `setStateLabel` を通す。
   * そのラベルが付いていなくても、失敗しない。
   */
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  /** 書き込み。直接呼ばず、必ず下の `createPullRequest` を通す。 */
  createPullRequest(
    repo: string,
    input: NewPullRequest,
  ): Promise<GitHubPullRequest>;
  /** 書き込み。直接呼ばず、必ず下の `updatePullRequest` を通す。 */
  updatePullRequest(
    repo: string,
    number: number,
    content: PullRequestContent,
  ): Promise<void>;
  /** 書き込み。直接呼ばず、必ず下の `addIssueComment` を通す。 */
  createIssueComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void>;
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

/**
 * イシューからラベルを1つ外す。付いていなければ、何も変わらない(やり直して安全)。
 * 状態のラベル(`state:`)は、ここではなく `setStateLabel` で付け替える。
 * `dry_run` が `true` のときは通信せず、外す予定だったことをログに出して `false` を返す。
 */
export async function removeLabel(
  ctx: WriteContext,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<boolean> {
  if (label.startsWith("state:")) {
    throw new Error(
      `状態のラベルは、付け替えで変えます(外すだけにはできません): ${label}`,
    );
  }
  const fields = {
    action: "remove_label",
    repo,
    issue: issueNumber,
    label,
  };
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", { reason: "dry_run", ...fields });
    return false;
  }
  await ctx.api.removeLabel(repo, issueNumber, label);
  ctx.logger.info("github.write", fields);
  return true;
}

/** 状態を表すラベル。`closed` はラベルではなく、イシューのクローズで表す。 */
function stateLabel(state: IssueState): string {
  if (state === "closed") {
    throw new Error(
      "closed はラベルで表せません(イシューのクローズで表します)",
    );
  }
  return `state:${state}`;
}

/**
 * イシューの状態のラベルを、`from` から `to` に付け替える。
 *
 * 遷移表による検査は、呼び出す側が先に済ませる。ここは書き込みだけを行う。
 * 新しいラベルを付けてから、古いラベルを外す。途中で止まっても、もう一度呼べば同じ結果になる
 * (付いているラベルを付けても、付いていないラベルを外しても、失敗しない)。
 *
 * `dry_run` が `true` のときは通信せず、付け替える予定だったことをログに出して `false` を返す。
 */
export async function setStateLabel(
  ctx: WriteContext,
  repo: string,
  issueNumber: number,
  change: { from: IssueState; to: IssueState },
): Promise<boolean> {
  const add = stateLabel(change.to);
  const remove = stateLabel(change.from);
  if (add === remove) {
    throw new Error(`同じ状態には付け替えられません: ${add}`);
  }
  const fields = {
    action: "set_state_label",
    repo,
    issue: issueNumber,
    add,
    remove,
  };
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", { reason: "dry_run", ...fields });
    return false;
  }
  await ctx.api.addLabels(repo, issueNumber, [add]);
  await ctx.api.removeLabel(repo, issueNumber, remove);
  ctx.logger.info("github.write", fields);
  return true;
}

/** ファクトリーが push してよいブランチ(`agent/issue-<番号>`)。 */
const AGENT_BRANCH_PATTERN = /^agent\/issue-[1-9]\d*$/;

export interface PushInput {
  /** gitの実行。フックを無効にし、事務局の環境変数を引き継がないもの(`git.ts`)を渡す。 */
  readonly git: Git;
  /** 事務局専用のミラー。push はここから行う。 */
  readonly mirrorDir: string;
  readonly repo: string;
  /** push 先のURL。トークンを含めない。 */
  readonly url: string;
  /** push に使うトークン。gitの実行時にだけ渡し、どこにも保存しない。 */
  readonly token?: string;
  readonly branch: string;
}

/**
 * ミラーにあるブランチを、同じ名前で push する。
 *
 * push できるのは、作業用のブランチ(`agent/issue-<番号>`)だけで、それ以外は失敗させる。
 * 既定ブランチには、ここからは書き込めない。作業用のブランチはファクトリーだけが使うので、
 * 差し戻しで履歴が変わっていても通るように、上書きで push する。やり直して安全である。
 *
 * `dry_run` が `true` のときは push せず、予定だったことをログに出して `false` を返す。
 */
export async function pushBranch(
  ctx: Pick<WriteContext, "dryRun" | "logger">,
  input: PushInput,
): Promise<boolean> {
  const { repo, branch } = input;
  if (!AGENT_BRANCH_PATTERN.test(branch)) {
    throw new Error(
      `push できるのは作業用のブランチ(agent/issue-<番号>)だけです: ${branch}`,
    );
  }
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", {
      reason: "dry_run",
      action: "push",
      repo,
      branch,
    });
    return false;
  }
  await input.git.run(
    [
      "push",
      "--quiet",
      "--force",
      // フックは `git.ts` が毎回無効にしている。ここでも重ねて止める。
      "--no-verify",
      "--",
      input.url,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    {
      cwd: input.mirrorDir,
      ...(input.token === undefined
        ? {}
        : { auth: { url: input.url, token: input.token } }),
    },
  );
  ctx.logger.info("github.write", { action: "push", repo, branch });
  return true;
}

/**
 * PRを作る。
 * `dry_run` が `true` のときは通信せず、作る予定だったことをログに出して null を返す。
 */
export async function createPullRequest(
  ctx: WriteContext,
  repo: string,
  input: NewPullRequest,
): Promise<GitHubPullRequest | null> {
  const fields = {
    action: "create_pull_request",
    repo,
    head: input.head,
    base: input.base,
    title: input.title,
  };
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", { reason: "dry_run", ...fields });
    return null;
  }
  const created = await ctx.api.createPullRequest(repo, input);
  ctx.logger.info("github.write", { ...fields, pr: created.number });
  return created;
}

/**
 * PRのタイトルと本文を更新する。
 * `dry_run` が `true` のときは通信せず、更新する予定だったことをログに出して `false` を返す。
 */
export async function updatePullRequest(
  ctx: WriteContext,
  repo: string,
  number: number,
  content: PullRequestContent,
): Promise<boolean> {
  const fields = {
    action: "update_pull_request",
    repo,
    pr: number,
    title: content.title,
  };
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", { reason: "dry_run", ...fields });
    return false;
  }
  await ctx.api.updatePullRequest(repo, number, content);
  ctx.logger.info("github.write", fields);
  return true;
}

/** 本文に目印がなければ、末尾に付ける。 */
export function withFactoryMarker(body: string): string {
  return body.includes(FACTORY_MARKER)
    ? body
    : `${body.trimEnd()}\n\n${FACTORY_MARKER}\n`;
}

/**
 * イシューにコメントする。本文には目印(`<!-- factory -->`)を付ける。
 * `dry_run` が `true` のときは通信せず、書く予定だったことをログに出して `false` を返す。
 */
export async function addIssueComment(
  ctx: WriteContext,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<boolean> {
  if (body.trim() === "") {
    throw new Error("コメントの本文が空です");
  }
  const fields = {
    action: "add_issue_comment",
    repo,
    issue: issueNumber,
    chars: body.length,
  };
  if (ctx.dryRun) {
    ctx.logger.info("github.write_skipped", { reason: "dry_run", ...fields });
    return false;
  }
  await ctx.api.createIssueComment(repo, issueNumber, withFactoryMarker(body));
  ctx.logger.info("github.write", fields);
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
  body: z.string().nullish(),
  state: z.enum(["open", "closed"]),
  labels: z.array(
    z.union([z.string(), z.object({ name: z.string().nullish() })]),
  ),
  user: UserSchema,
  assignees: z.array(UserSchema).nullish(),
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

const PullRequestSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
});

const LabelSchema = z.object({ name: z.string() });

const ReviewSchema = z.object({
  id: z.number().int(),
  user: UserSchema,
  state: z.string(),
  body: z.string().nullish(),
  commit_id: z.string().nullish(),
  submitted_at: Timestamp.nullish(),
});

const ReviewCommentSchema = z.object({
  id: z.number().int(),
  pull_request_review_id: z.number().int().nullish(),
  path: z.string(),
  line: z.number().int().nullish(),
  original_line: z.number().int().nullish(),
  body: z.string().nullish(),
});

/**
 * PRのレビューコメントの一覧(GitHubの応答)から、レビュー1件の行ごとのコメントを取り出す。純粋関数。
 *
 * 行は、いまの差分での行(`line`)を使い、なければ、コメントを書いた時点の行(`original_line`)を使う。
 * コメントの後でコミットが積まれると、`line` は null になるからである。
 * ファイル全体へのコメントは、どちらもないので、null になる。
 */
export function reviewCommentsFrom(
  items: readonly unknown[],
  reviewId: number,
  context: string,
): GitHubReviewComment[] {
  return items
    .map((item) => parseResponse(ReviewCommentSchema, item, context))
    .filter((comment) => comment.pull_request_review_id === reviewId)
    .map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      body: comment.body ?? "",
    }));
}

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

function toComment(item: unknown, what: string): GitHubComment {
  const comment = parseResponse(CommentSchema, item, what);
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
}

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
    async getAuthenticatedLogin() {
      const response = await octokit.rest.users.getAuthenticated();
      return parseResponse(
        z.object({ login: z.string().min(1) }),
        response.data,
        "トークンの持ち主",
      ).login;
    },

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
          body: issue.body ?? "",
          open: issue.state === "open",
          labels: issue.labels
            .map((label) => (typeof label === "string" ? label : label.name))
            .filter((name): name is string => typeof name === "string"),
          author: issue.user?.login ?? null,
          assignees: (issue.assignees ?? [])
            .map((user) => user?.login)
            .filter((login): login is string => typeof login === "string"),
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
      return items.map((item) => toComment(item, `${repo} のコメント`));
    },

    async listCommentsOnIssue(repo, issueNumber) {
      const items = await octokit.paginate(octokit.rest.issues.listComments, {
        ...splitRepo(repo),
        issue_number: issueNumber,
        per_page: 100,
      });
      return items.map((item) =>
        toComment(item, `${repo} のイシュー ${issueNumber} のコメント`),
      );
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

    async findOpenPullRequest(repo, head) {
      const target = splitRepo(repo);
      const response = await octokit.rest.pulls.list({
        ...target,
        state: "open",
        head: `${target.owner}:${head}`,
        per_page: 1,
      });
      const [first] = parseResponse(
        z.array(PullRequestSchema),
        response.data,
        `${repo} のPRの一覧`,
      );
      return first === undefined
        ? null
        : { number: first.number, url: first.html_url };
    },

    async listPullRequestReviews(repo, prNumber) {
      const items = await octokit.paginate(octokit.rest.pulls.listReviews, {
        ...splitRepo(repo),
        pull_number: prNumber,
        per_page: 100,
      });
      return items.map((item) => {
        const review = parseResponse(
          ReviewSchema,
          item,
          `${repo} のPR ${prNumber} のレビュー`,
        );
        return {
          id: review.id,
          author: review.user?.login ?? null,
          state: review.state,
          body: review.body ?? "",
          commitId: review.commit_id ?? null,
          submittedAt: review.submitted_at ?? null,
        };
      });
    },

    async listReviewComments(repo, prNumber, reviewId) {
      // レビューごとの一覧(`listCommentsForReview`)は、行番号を返さない。
      // PRのコメントの一覧から、そのレビューの分を取り出す。
      const items = await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        {
          ...splitRepo(repo),
          pull_number: prNumber,
          per_page: 100,
        },
      );
      return reviewCommentsFrom(
        items,
        reviewId,
        `${repo} のPR ${prNumber} のレビューコメント`,
      );
    },

    async listLabelsOnIssue(repo, issueNumber) {
      const items = await octokit.paginate(
        octokit.rest.issues.listLabelsOnIssue,
        { ...splitRepo(repo), issue_number: issueNumber, per_page: 100 },
      );
      return items.map(
        (item) =>
          parseResponse(LabelSchema, item, `${repo} の ${issueNumber} のラベル`)
            .name,
      );
    },

    async addLabels(repo, issueNumber, labels) {
      await octokit.rest.issues.addLabels({
        ...splitRepo(repo),
        issue_number: issueNumber,
        labels,
      });
    },

    async removeLabel(repo, issueNumber, label) {
      try {
        await octokit.rest.issues.removeLabel({
          ...splitRepo(repo),
          issue_number: issueNumber,
          name: label,
        });
      } catch (error) {
        // 付いていないラベルは、外し終わっているものとして扱う。
        if (statusOf(error) !== 404) throw error;
      }
    },

    async createPullRequest(repo, input) {
      const response = await octokit.rest.pulls.create({
        ...splitRepo(repo),
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
      });
      const created = parseResponse(
        PullRequestSchema,
        response.data,
        `${repo} の作成したPR`,
      );
      return { number: created.number, url: created.html_url };
    },

    async updatePullRequest(repo, number, content) {
      await octokit.rest.pulls.update({
        ...splitRepo(repo),
        pull_number: number,
        title: content.title,
        body: content.body,
      });
    },

    async createIssueComment(repo, issueNumber, body) {
      await octokit.rest.issues.createComment({
        ...splitRepo(repo),
        issue_number: issueNumber,
        body,
      });
    },
  };
}
