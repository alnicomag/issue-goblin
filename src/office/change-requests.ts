/**
 * PRへの修正依頼(レビューの「変更を要求」)の取り込みと、実装のやり直し。
 *
 * - 合図は、PRのレビューの状態 `CHANGES_REQUESTED` だけである。
 * - 受け付けるかは、取り込んだ時点の `issues.allowed_authors` で決めて、記録に残す。
 *   受け付けない人の依頼も記録するが、何も起こさない。
 * - 受け付けた依頼は、クローズ待ちの実行を implement からやり直すときに、使用済みにする。
 *   依頼とやり直しの結び付きが記録に残るので、同じ依頼で2回はやり直さない。
 * - 依頼の内容は、implement の指摘(`feedback`)に、データとして入れる。
 *
 * 判定と整形は純粋関数で、DBにもネットワークにも触れない。
 */
import { z } from "zod";
import { type Clock, isoNow } from "./clock.ts";
import type { Db } from "./db.ts";
import type { GitHubApi, GitHubReview } from "./github.ts";
import { isAllowedLogin } from "./intake.ts";
import type { Logger } from "./log.ts";
import { errorFields } from "./log.ts";
import { inlineCode } from "./path-list.ts";
import { readStoredFactoryYml } from "./product.ts";
import { getRun, listSteps, type Run } from "./runs.ts";

/** 修正依頼として扱う、レビューの状態。 */
export const CHANGES_REQUESTED = "CHANGES_REQUESTED";

/** 指摘に載せる、レビューの本文の文字数の上限。 */
export const REQUEST_BODY_LIMIT = 20_000;
/** 指摘に載せる、行ごとのコメントの数の上限(依頼1件につき)。 */
export const REQUEST_COMMENT_LIMIT = 50;
/** 指摘に載せる、行ごとのコメント1件の文字数の上限。 */
export const REQUEST_COMMENT_BODY_LIMIT = 4_000;

const ReviewCommentsSchema = z.array(
  z.object({
    path: z.string(),
    line: z.number().int().nullable(),
    body: z.string(),
  }),
);
export type ChangeRequestComment = z.infer<typeof ReviewCommentsSchema>[number];

const ChangeRequestRowSchema = z
  .object({
    id: z.number().int(),
    repo: z.string(),
    issue_number: z.number().int(),
    pr_number: z.number().int(),
    review_id: z.number().int(),
    author: z.string().nullable(),
    accepted: z.number().int(),
    body: z.string(),
    comments: z.string(),
    commit_id: z.string().nullable(),
    submitted_at: z.string(),
    run_id: z.number().int().nullable(),
    step_id: z.number().int().nullable(),
    used_at: z.string().nullable(),
  })
  .transform((row) => ({
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    prNumber: row.pr_number,
    reviewId: row.review_id,
    author: row.author,
    accepted: row.accepted !== 0,
    body: row.body,
    comments: ReviewCommentsSchema.parse(JSON.parse(row.comments)),
    commitId: row.commit_id,
    submittedAt: row.submitted_at,
    /** やり直した実行。未使用なら null。 */
    runId: row.run_id,
    /** やり直しの最初の implement のステップ。未使用なら null。 */
    stepId: row.step_id,
    usedAt: row.used_at,
  }));
export type ChangeRequest = z.infer<typeof ChangeRequestRowSchema>;

const COLUMNS =
  "id, repo, issue_number, pr_number, review_id, author, accepted, body, comments, commit_id, submitted_at, run_id, step_id, used_at";

function parseRow(row: unknown): ChangeRequest {
  const result = ChangeRequestRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error("change_requests の行が想定外の内容です", {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * レビューが、取り込む修正依頼かどうか。純粋関数。
 * 出される前のレビュー(`PENDING`)と、ほかの状態(承認、コメントだけ、取り下げ済み)は、取り込まない。
 */
export function isChangeRequest(review: GitHubReview): boolean {
  return review.state === CHANGES_REQUESTED && review.submittedAt !== null;
}

/**
 * 修正依頼を受け付けるかどうか。純粋関数。
 * 受け付けるのは、`issues.allowed_authors` にいる人の依頼だけである(大文字と小文字を区別しない)。
 */
export function isAcceptedRequester(
  author: string | null,
  allowedAuthors: readonly string[],
): boolean {
  return isAllowedLogin(author, allowedAuthors);
}

/**
 * PRを持つ実行中の実行について、PRのレビューを読み、修正依頼を記録する。記録した数を返す。
 *
 * GitHubには書かない。レビューのIDで既出かを確かめるので、何度行っても、同じ依頼は1行だけになる。
 * `factory.yml` を読めないリポジトリでは、受け付けるかを決められないので、取り込まない
 * (記録していないので、読めるようになった後のポーリングで取り込む)。
 */
export async function syncChangeRequests(deps: {
  db: Db;
  api: GitHubApi;
  repo: string;
  clock: Clock;
  logger: Logger;
}): Promise<number> {
  const { db, api, repo, logger } = deps;
  const runs = db
    .prepare(
      `SELECT issue_number AS issue, pr_number AS pr FROM runs
       WHERE repo = ? AND status = 'running' AND pr_number IS NOT NULL
       ORDER BY id`,
    )
    .all(repo) as { issue: number; pr: number }[];
  if (runs.length === 0) return 0;

  let allowedAuthors: readonly string[];
  try {
    allowedAuthors = readStoredFactoryYml(db, repo).issues.allowed_authors;
  } catch (error) {
    logger.warn("change_request.sync_skipped", { repo, ...errorFields(error) });
    return 0;
  }

  const known = db.prepare(
    "SELECT 1 FROM change_requests WHERE repo = ? AND review_id = ?",
  );
  let recorded = 0;
  for (const run of runs) {
    const reviews = await api.listPullRequestReviews(repo, run.pr);
    for (const review of reviews) {
      if (!isChangeRequest(review)) continue;
      if (known.get(repo, review.id) !== undefined) continue;
      const comments = await api.listReviewComments(repo, run.pr, review.id);
      const accepted = isAcceptedRequester(review.author, allowedAuthors);
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO change_requests
             (repo, issue_number, pr_number, review_id, author, accepted, body,
              comments, commit_id, submitted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          repo,
          run.issue,
          run.pr,
          review.id,
          review.author,
          accepted ? 1 : 0,
          review.body,
          JSON.stringify(
            comments.map((comment) => ({
              path: comment.path,
              line: comment.line,
              body: comment.body,
            })),
          ),
          review.commitId,
          review.submittedAt,
          isoNow(deps.clock),
        );
      if (info.changes === 0) continue;
      recorded += 1;
      logger.info("change_request.recorded", {
        repo,
        issue: run.issue,
        pr: run.pr,
        review: review.id,
        author: review.author,
        accepted,
      });
    }
  }
  return recorded;
}

/** 受け付けたが、まだやり直しに使っていない修正依頼(古い順)。 */
export function pendingChangeRequests(
  db: Db,
  repo: string,
  issueNumber: number,
): ChangeRequest[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM change_requests
       WHERE repo = ? AND issue_number = ? AND accepted = 1 AND used_at IS NULL
       ORDER BY submitted_at, id`,
    )
    .all(repo, issueNumber)
    .map(parseRow);
}

/**
 * やり直しを始めたが、まだ直し終えていない修正依頼(古い順)。implement に渡す。
 *
 * 直し終えたとみなすのは、やり直しを始めた後に、そのイシューの publish が `done` で終わったときである。
 * それまでは、差し戻しや再試行(新しい実行)をまたいで、渡し続ける。
 */
export function openChangeRequests(
  db: Db,
  repo: string,
  issueNumber: number,
): ChangeRequest[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM change_requests
       WHERE repo = ? AND issue_number = ? AND accepted = 1
         AND step_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM steps JOIN runs ON runs.id = steps.run_id
           WHERE runs.repo = change_requests.repo
             AND runs.issue_number = change_requests.issue_number
             AND steps.name = 'publish' AND steps.status = 'done'
             AND steps.id > change_requests.step_id)
       ORDER BY submitted_at, id`,
    )
    .all(repo, issueNumber)
    .map(parseRow);
}

/**
 * クローズ待ちの実行を、修正依頼を受けて、implement からやり直せるようにする。
 *
 * implement のステップを始め、未使用の依頼を使用済みにして、そのステップに結び付ける
 * (1つのトランザクション)。plan はやり直さない。試行回数は変わらない。
 * すでにやり直しを始めてあれば(実行中の implement に依頼が結び付いている)、何もしない。
 * クローズ待ちでない実行と、未使用の依頼がない実行は、エラーにする。
 */
export function reopenForChangeRequests(
  db: Db,
  clock: Clock,
  runId: number,
): { run: Run; requests: ChangeRequest[] } {
  return db
    .transaction((): { run: Run; requests: ChangeRequest[] } => {
      const run = getRun(db, runId);
      const last = listSteps(db, runId).at(-1);
      if (
        run.status === "running" &&
        last?.name === "implement" &&
        last.status === "running"
      ) {
        const linked = db
          .prepare(`SELECT ${COLUMNS} FROM change_requests WHERE step_id = ?`)
          .all(last.id)
          .map(parseRow);
        if (linked.length > 0) return { run, requests: linked };
      }
      if (
        run.status !== "running" ||
        last?.name !== "publish" ||
        last.status !== "done"
      ) {
        throw new Error(
          `実行 ${runId} は、クローズ待ちではありません(${run.status})。修正依頼でやり直せません`,
        );
      }
      const pending = pendingChangeRequests(db, run.repo, run.issueNumber);
      if (pending.length === 0) {
        throw new Error(
          `実行 ${runId} には、未使用の修正依頼がありません。やり直せません`,
        );
      }
      const now = isoNow(clock);
      const info = db
        .prepare(
          `INSERT INTO steps (run_id, name, status, started_at)
           VALUES (?, 'implement', 'running', ?)`,
        )
        .run(runId, now);
      const stepId = Number(info.lastInsertRowid);
      db.prepare("UPDATE runs SET current_step = 'implement' WHERE id = ?").run(
        runId,
      );
      const use = db.prepare(
        "UPDATE change_requests SET run_id = ?, step_id = ?, used_at = ? WHERE id = ?",
      );
      for (const request of pending) use.run(runId, stepId, now, request.id);
      return {
        run: getRun(db, runId),
        requests: pending.map((request) => ({
          ...request,
          runId,
          stepId,
          usedAt: now,
        })),
      };
    })
    .immediate();
}

/**
 * 指示書の入力を囲むタグに見える書き方を崩す。
 * 依頼の文章が、指摘の囲みを閉じて、囲みの外の文章に見えるのを防ぐ。
 */
function neutralizeTags(text: string): string {
  return text.replace(/<(\/?[a-z][a-z0-9_]*\s*)>/gi, "＜$1>");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n(長いので、ここで切りました。全体は ${text.length} 文字です)`;
}

/** 依頼の文章を、指摘に載せる形にする(長さの上限と、タグの無害化)。 */
function quoteText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed === "") return "(本文なし)";
  return neutralizeTags(truncate(trimmed, limit));
}

/**
 * 修正依頼を、implement の指摘(`feedback`)に入れる文章にする。純粋関数。
 * 依頼がなければ空文字を返す。
 *
 * 依頼は人間が書いた文章で、行コメントのパスはワーカーが決められる文字列である。
 * どちらもデータとして載せ、指示書の入力の囲みに見える書き方を崩す。
 */
export function formatChangeRequests(
  requests: readonly ChangeRequest[],
): string {
  if (requests.length === 0) return "";
  const lines = [
    "## プルリクエストへの修正依頼(人間のレビュー)",
    "",
    "人間が、このイシューのプルリクエストをレビューして、修正を求めました。",
    "作業用のブランチには、レビューされたコミットがすでにあります。作り直さずに、求められた点を新しいコミットで直します。",
  ];
  requests.forEach((request, index) => {
    const commit =
      request.commitId === null
        ? ""
        : `、対象のコミット: ${inlineCode(request.commitId)}`;
    lines.push(
      "",
      `### 修正依頼 ${index + 1}(${request.author ?? "不明"}、${request.submittedAt}${commit})`,
      "",
      quoteText(request.body, REQUEST_BODY_LIMIT),
    );
    if (request.comments.length === 0) return;
    lines.push("", "#### 行ごとのコメント");
    for (const comment of request.comments.slice(0, REQUEST_COMMENT_LIMIT)) {
      const where = comment.line === null ? "" : `(行 ${comment.line})`;
      lines.push(
        "",
        `- ${inlineCode(comment.path)}${where}:`,
        "",
        quoteText(comment.body, REQUEST_COMMENT_BODY_LIMIT)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      );
    }
    const rest = request.comments.length - REQUEST_COMMENT_LIMIT;
    if (rest > 0) lines.push("", `- (ほか ${rest} 件)`);
  });
  return `${lines.join("\n")}\n`;
}

/**
 * implement に渡す指摘の全体。修正依頼と、直前の差し戻しの指摘を合わせる。純粋関数。
 * 修正依頼がなければ、差し戻しの指摘をそのまま返す。
 */
export function combineFeedback(
  changeRequests: string,
  rework: string,
): string {
  if (changeRequests === "") return rework;
  if (rework.trim() === "") return changeRequests;
  return `${changeRequests}\n## 直前の差し戻しの指摘(検査またはレビュー)\n\n${rework}`;
}
