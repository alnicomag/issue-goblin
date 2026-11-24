/**
 * ステップの実行。1回の実行を、記録にある続きから、進められるところまで進める。
 *
 * 進み方の判断は `run-steps.ts`、記録は `runs.ts` に任せ、ここは各ステップを呼んで結果を渡すだけである。
 * イシューの状態(ラベル)は、ここでは変えない。状態の変更は、記録を見て `supervisor.ts` が行う。
 *
 * どのステップも、やり直して安全である。途中で止められた場合は、ステップを実行中のまま残すので、
 * 次に呼ばれたときに、そのステップからやり直す。
 */
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { WorkerInvocation, WorkerInvoker } from "../agents/worker.ts";
import type { WorkerLauncher } from "../launcher/client.ts";
import type { Clock } from "./clock.ts";
import type { CommitAuthor } from "./config.ts";
import type { Db } from "./db.ts";
import type { Git } from "./git.ts";
import type { WriteContext } from "./github.ts";
import { errorFields, type Logger } from "./log.ts";
import { readStoredFactoryYml } from "./product.ts";
import { importCommits, inspectChanges, publish } from "./publish.ts";
import type { FinishStatus, StepName, StepOutcome } from "./run-steps.ts";
import {
  approvedCommit,
  finishStep,
  getRun,
  listSteps,
  nextStep,
  type Run,
  recordInterruptedLog,
  recordRunDetails,
  type Step,
  startStep,
} from "./runs.ts";
import { DEFAULT_STEP_LIMITS, type StepLimits } from "./step-limits.ts";
import { runVerify } from "./verify.ts";
import {
  cleanupWorkspace,
  prepareWorkspace,
  type RepoSource,
  updateMirror,
  type WorkspaceDirs,
  workspacePaths,
} from "./workspace.ts";

export {
  type ClaudeLimit,
  DEFAULT_STEP_LIMITS,
  type StepLimits,
} from "./step-limits.ts";

/** review に渡す差分の長さの上限(文字数)。超えた分は切り、切ったことを書く。 */
export const MAX_DIFF_CHARS = 1_000_000;

export interface RunnerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  /** gitの実行。`git.ts` のものを渡す。 */
  readonly git: Git;
  /** 置き場所(設定の `repos_dir`、`work_dir`)。 */
  readonly dirs: WorkspaceDirs;
  /** ログの置き場所(設定の `logs_dir`)。 */
  readonly logsDir: string;
  /** ワーカーのコミットの作者(設定の `commit_author`)。 */
  readonly commitAuthor: CommitAuthor;
  /** 失敗後の待機時間(設定の `retry_wait_minutes`)。 */
  readonly retryWaitMinutes: readonly number[];
  /** 起動係に依頼する口。 */
  readonly launcher: WorkerLauncher;
  /** ワーカーの呼び出しを作る。渡す起動係は、実行を止めたときに依頼も止まるようにしたもの。 */
  readonly createWorker: (launcher: WorkerLauncher) => WorkerInvoker;
  /** リポジトリの取得と push の宛先。 */
  readonly sourceFor: (repo: string) => RepoSource;
  /** リポジトリへの書き込みの口と、`dry_run`。 */
  readonly writeFor: (repo: string) => WriteContext;
  /** ステップごとの上限(設定の `step_limits`)。省略すると、既定値を使う。 */
  readonly limits?: StepLimits;
}

/**
 * - `finished`: 実行が終わった。
 * - `waiting_close`: publish まで終わり、イシューのクローズを待っている(残りは cleanup だけ)。
 * - `aborted`: 止められた。実行中だったステップは、そのまま残っている。
 */
export type AdvanceResult =
  | { readonly kind: "finished"; readonly status: FinishStatus }
  | { readonly kind: "waiting_close" }
  | { readonly kind: "aborted" };

/** ステップを実行した結果。`steps` に記録する内容。 */
interface StepExecution {
  readonly outcome: StepOutcome;
  readonly output: Record<string, unknown>;
  readonly sessionId?: string | null;
  readonly costUsd?: number | null;
  readonly logPath?: string;
  /** ワーカーの呼び出し、または検査コマンドが、事務局の停止で中断された。 */
  readonly interrupted?: boolean;
}

interface IssueRow {
  title: string;
  body: string | null;
  state: string;
}

function readIssue(db: Db, repo: string, issue: number): IssueRow {
  const row = db
    .prepare(
      "SELECT title, body, state FROM issues WHERE repo = ? AND number = ?",
    )
    .get(repo, issue) as IssueRow | undefined;
  if (row === undefined) {
    throw new Error(`イシューがありません: ${repo}#${issue}`);
  }
  return row;
}

export interface IssueComment {
  readonly author: string | null;
  readonly body: string;
  readonly commentedAt: string | null;
}

const CommentPayloadSchema = z.object({
  comment_id: z.number(),
  author: z.string().nullable().optional(),
  body: z.string(),
  commented_at: z.string().optional(),
});

/** 記録してある、人間のコメント(古い順)。同じコメントが編集されていれば、新しい内容を使う。 */
export function readIssueComments(
  db: Db,
  repo: string,
  issue: number,
): IssueComment[] {
  const rows = db
    .prepare(
      `SELECT payload FROM events
       WHERE type = 'issue.commented' AND repo = ? AND issue_number = ?
       ORDER BY id`,
    )
    .all(repo, issue) as { payload: string }[];
  const byId = new Map<number, IssueComment>();
  for (const row of rows) {
    const parsed = CommentPayloadSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success) {
      throw new Error(`コメントの記録が想定外の内容です(${repo}#${issue})`, {
        cause: parsed.error,
      });
    }
    byId.set(parsed.data.comment_id, {
      author: parsed.data.author ?? null,
      body: parsed.data.body,
      commentedAt: parsed.data.commented_at ?? null,
    });
  }
  return [...byId.values()];
}

/** 指示書に差し込む、イシューの内容(タイトル、本文、コメント)。純粋関数。 */
export function formatIssue(input: {
  number: number;
  title: string;
  body: string | null;
  comments: readonly IssueComment[];
}): string {
  const lines = [
    `# ${input.title}(#${input.number})`,
    "",
    input.body?.trim() || "(本文なし)",
  ];
  input.comments.forEach((comment, index) => {
    const when = comment.commentedAt === null ? "" : `、${comment.commentedAt}`;
    lines.push(
      "",
      `## コメント ${index + 1}(${comment.author ?? "不明"}${when})`,
      "",
      comment.body.trim(),
    );
  });
  return `${lines.join("\n")}\n`;
}

/** チェックポイントの内容を、オブジェクトとして読む。なければ空。 */
function outputOf(step: Step | undefined): Record<string, unknown> {
  if (step?.output == null) return {};
  const raw: unknown = JSON.parse(step.output);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function summaryOf(step: Step | undefined): string {
  const summary = outputOf(step).summary;
  return typeof summary === "string" ? summary : "";
}

/**
 * `done` で終わった最後のステップの要約。PRの本文に載せる。なければ null。
 * 差し戻しがあった実行では、最後のやり直しのものになる。
 */
export function lastDoneSummary(
  steps: readonly Step[],
  name: StepName,
): string | null {
  const step = steps.findLast(
    (candidate) => candidate.name === name && candidate.status === "done",
  );
  const summary = summaryOf(step);
  return summary.trim() === "" ? null : summary;
}

const VerifyOutputSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  commands: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      exitCode: z.number().nullable(),
      outputTail: z.string().default(""),
    }),
  ),
  /** 作業場所に残っていた、コミットされていないパス。以前の記録にはない。 */
  uncommittedPaths: z.array(z.string()).optional(),
  uncommittedCount: z.number().optional(),
  /** 作業用のブランチ以外が取り出されていた場合の記録。以前の記録にはない。 */
  wrongBranch: z
    .object({ checkedOut: z.string(), expected: z.string() })
    .nullish(),
});
type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

/** 最後に終わった verify の結果。なければ null。 */
function lastVerify(steps: readonly Step[]): VerifyOutput | null {
  const step = steps.findLast(
    (candidate) =>
      candidate.name === "verify" &&
      (candidate.status === "done" || candidate.status === "rework"),
  );
  if (step === undefined) return null;
  const parsed = VerifyOutputSchema.safeParse(outputOf(step));
  if (!parsed.success) {
    throw new Error("verify の記録が想定外の内容です", { cause: parsed.error });
  }
  return parsed.data;
}

/** verify の結果を、指示書に差し込む文章にする。純粋関数。 */
export function formatVerify(verify: VerifyOutput | null): string {
  if (verify === null) return "(検査の記録がありません)";
  const lines = [verify.summary, ""];
  for (const command of verify.commands) {
    const code = command.exitCode === null ? "なし" : String(command.exitCode);
    lines.push(`- ${command.name}: ${command.status}(終了コード: ${code})`);
  }
  if (verify.wrongBranch != null) {
    lines.push(
      "",
      "### 取り出されているブランチ",
      "",
      `- 取り出されていたもの: ${verify.wrongBranch.checkedOut}`,
      `- 戻すべきブランチ(作業用のブランチ): ${verify.wrongBranch.expected}`,
    );
  }
  const paths = verify.uncommittedPaths ?? [];
  if (paths.length > 0) {
    lines.push("", "### コミットされていないパス", "");
    for (const entry of paths) lines.push(`- ${entry}`);
    const rest = (verify.uncommittedCount ?? paths.length) - paths.length;
    if (rest > 0) lines.push(`- (ほか ${rest} 件)`);
  }
  for (const command of verify.commands) {
    if (command.outputTail.trim() === "") continue;
    lines.push("", `### ${command.name} の出力の末尾`, "", command.outputTail);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * implement に渡す、差し戻しの指摘。
 * 直前に終わったステップが差し戻し(verify の失敗、review の修正要求)なら、その内容。なければ空。
 */
export function feedbackFor(steps: readonly Step[]): string {
  const finished = steps.filter((step) => step.status !== "running");
  const last = finished.at(-1);
  if (last?.status !== "rework") return "";
  if (last.name === "verify") {
    return formatVerify(lastVerify(finished));
  }
  return summaryOf(last);
}

function isRealDir(target: string): boolean {
  return (
    fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true
  );
}

function workerExecution(
  invocation: WorkerInvocation,
  extra: Record<string, unknown> = {},
): StepExecution {
  return {
    outcome: invocation.status,
    output: {
      summary: invocation.summary,
      numTurns: invocation.numTurns,
      ...extra,
    },
    sessionId: invocation.sessionId,
    costUsd: invocation.costUsd,
    logPath: invocation.logPath,
    interrupted: invocation.interrupted,
  };
}

/** 1つのステップを実行する。 */
async function executeStep(
  deps: RunnerDeps,
  run: Run,
  step: StepName,
  signal: AbortSignal,
): Promise<StepExecution> {
  const { db, git, dirs } = deps;
  const repo = run.repo;
  const issue = run.issueNumber;
  const limits = deps.limits ?? DEFAULT_STEP_LIMITS;
  // 実行が止められたら、起動係への依頼も止める。
  const launcher: WorkerLauncher = {
    run: (request) => deps.launcher.run(request, { signal }),
  };
  const paths = workspacePaths(dirs, repo, issue);
  const steps = listSteps(db, run.id);

  const issueText = () => {
    const row = readIssue(db, repo, issue);
    return formatIssue({
      number: issue,
      title: row.title,
      body: row.body,
      comments: readIssueComments(db, repo, issue),
    });
  };
  const factoryYmlText = () => stringifyYaml(readStoredFactoryYml(db, repo));

  switch (step) {
    case "prepare": {
      const prepared = await prepareWorkspace(
        { git },
        {
          dirs,
          repo,
          issue,
          source: deps.sourceFor(repo),
          author: deps.commitAuthor,
        },
      );
      recordRunDetails(db, run.id, {
        workspacePath: prepared.issueDir,
        branch: prepared.branch,
      });
      return {
        outcome: "done",
        output: {
          workspace: prepared.issueDir,
          branch: prepared.branch,
          created: prepared.created,
        },
      };
    }

    case "plan": {
      const invocation = await deps.createWorker(launcher).invoke({
        repo,
        issue,
        step: "plan",
        prompt: "plan",
        values: { issue: issueText(), factory_yml: factoryYmlText() },
        ...limits.plan,
      });
      return workerExecution(invocation);
    }

    case "implement": {
      const plan = steps.findLast(
        (candidate) => candidate.name === "plan" && candidate.status === "done",
      );
      const invocation = await deps.createWorker(launcher).invoke({
        repo,
        issue,
        step: "implement",
        prompt: "implement",
        values: {
          issue: issueText(),
          factory_yml: factoryYmlText(),
          plan: summaryOf(plan),
          feedback: feedbackFor(steps),
        },
        ...limits.implement,
      });
      // 申告ではなく、作業場所にあるコミットを記録する。
      let headCommit: string | null = null;
      if (
        isRealDir(paths.repoDir) &&
        isRealDir(path.join(paths.repoDir, ".git"))
      ) {
        const head = await git.run(
          [
            `--git-dir=${path.join(paths.repoDir, ".git")}`,
            "for-each-ref",
            "--format=%(objectname)",
            `refs/heads/${paths.branch}`,
          ],
          { cwd: paths.repoDir },
        );
        headCommit = head.trim() || null;
      }
      return workerExecution(invocation, { headCommit });
    }

    case "verify": {
      const result = await runVerify(
        { db, launcher, dirs, logsDir: deps.logsDir, clock: deps.clock },
        { repo, issue, timeoutSec: limits.verifyTimeoutSec },
      );
      return {
        outcome: result.outcome,
        output: {
          summary: result.summary,
          passed: result.passed,
          failedCommands: result.failedCommands,
          commands: result.commands,
          uncommittedPaths: result.uncommittedPaths,
          uncommittedCount: result.uncommittedCount,
          wrongBranch: result.wrongBranch,
        },
        logPath: result.logPath,
        interrupted: result.interrupted,
      };
    }

    case "review": {
      // 差分は、作業場所ではなく、取り込んだミラーで作る(publish と同じ基準)。
      const baseBranch = await updateMirror(
        git,
        paths.mirrorDir,
        deps.sourceFor(repo),
      );
      const imported = await importCommits(git, paths);
      if (imported === null) {
        return {
          outcome: "failed",
          output: {
            summary: `作業場所にブランチ ${paths.branch} がありません。レビューする差分がありません`,
          },
        };
      }
      const changes = await inspectChanges(git, {
        mirrorDir: paths.mirrorDir,
        branch: paths.branch,
        defaultBranch: baseBranch,
      });
      let diff = await git.run(
        [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          changes.mergeBase,
          changes.headCommit,
          "--",
        ],
        { cwd: paths.mirrorDir },
      );
      if (diff.length > MAX_DIFF_CHARS) {
        diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n(差分が長いので、ここで切りました。全体は ${diff.length} 文字です)\n`;
      }
      const invocation = await deps.createWorker(launcher).invoke({
        repo,
        issue,
        step: "review",
        prompt: "review",
        values: {
          issue: issueText(),
          factory_yml: factoryYmlText(),
          diff,
          test_result: formatVerify(lastVerify(steps)),
        },
        ...limits.review,
      });
      return workerExecution(invocation, { headCommit: changes.headCommit });
    }

    case "publish": {
      const result = await publish(
        { db, git, write: deps.writeFor(repo), dirs },
        {
          repo,
          issue,
          issueTitle: readIssue(db, repo, issue).title,
          source: deps.sourceFor(repo),
          author: deps.commitAuthor,
          verify: lastVerify(steps),
          implementSummary: lastDoneSummary(steps, "implement"),
          reviewSummary: lastDoneSummary(steps, "review"),
          // 人間が承認したコミット。承認から再開した実行だけが持つ。
          approvedCommit: approvedCommit(db, run.id),
        },
      );
      if (result.prNumber !== null) {
        recordRunDetails(db, run.id, { prNumber: result.prNumber });
      }
      return {
        outcome: result.outcome,
        output: {
          summary: result.summary,
          status: result.status,
          awaitingApproval: result.awaitingApproval,
          headCommit: result.headCommit,
          // 人間の対応待ちで止まったとき、イシューへのコメントに載せる。
          forbidden: result.forbidden,
          protected: result.protected,
          // 承認待ちで止まったとき、人間が中身を確かめられるように、コメントに載せる。
          protectedDiff: result.protectedDiff,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
        },
      };
    }

    case "cleanup": {
      const cleaned = cleanupWorkspace({ dirs, repo, issue });
      return { outcome: "done", output: { removed: cleaned.issueDir } };
    }
  }
}

/**
 * 実行を、記録にある続きから進める。
 *
 * 実行が終わるか、イシューのクローズを待つところまで進むか、`signal` で止められるまで戻らない。
 * ステップの中で起きた例外は、そのステップの失敗として記録する(実行は `failed` で終わり、待機後に再試行される)。
 *
 * 止められた場合は、結果を記録せずに戻る。実行中だったステップは、次に呼ばれたときにやり直す。
 * ワーカーの呼び出しか検査コマンドを中断した場合だけ、そのログの場所を、実行中のステップに残す。
 */
export async function advanceRun(
  deps: RunnerDeps,
  runId: number,
  signal: AbortSignal,
): Promise<AdvanceResult> {
  const { db, clock, logger } = deps;
  for (;;) {
    if (signal.aborted) return { kind: "aborted" };
    const run = getRun(db, runId);
    if (run.status === "cancelled") return { kind: "aborted" };
    if (run.status !== "running") {
      return { kind: "finished", status: run.status };
    }
    const { step, interrupted } = nextStep(db, runId);
    // cleanup は、マージまたはクローズの後に行う。
    if (
      step === "cleanup" &&
      readIssue(db, run.repo, run.issueNumber).state !== "closed"
    ) {
      return { kind: "waiting_close" };
    }

    startStep(db, clock, runId, step);
    const fields = {
      repo: run.repo,
      issue: run.issueNumber,
      run: runId,
      step,
    };
    logger.info("run.step_started", { ...fields, resumed: interrupted });

    let execution: StepExecution;
    try {
      execution = await executeStep(deps, run, step, signal);
    } catch (error) {
      if (signal.aborted) return { kind: "aborted" };
      logger.error("run.step_error", { ...fields, ...errorFields(error) });
      const message = error instanceof Error ? error.message : String(error);
      execution = {
        outcome: "failed",
        output: { summary: `ステップを実行できませんでした: ${message}` },
      };
    }
    // 止められた後の結果は、中断によるものかもしれないので、記録しない。
    // 中断した呼び出しや検査のログは、再開したステップから辿れるように、場所だけを残す。
    if (signal.aborted) {
      if (execution.interrupted === true && execution.logPath !== undefined) {
        recordInterruptedLog(db, runId, step, execution.logPath);
        logger.info("run.step_interrupted", {
          ...fields,
          log_path: execution.logPath,
        });
      }
      return { kind: "aborted" };
    }

    const action = finishStep(
      db,
      clock,
      {
        runId,
        step,
        outcome: execution.outcome,
        output: execution.output,
        ...(execution.sessionId == null
          ? {}
          : { sessionId: execution.sessionId }),
        ...(execution.costUsd == null ? {} : { costUsd: execution.costUsd }),
        ...(execution.logPath === undefined
          ? {}
          : { logPath: execution.logPath }),
      },
      { retryWaitMinutes: deps.retryWaitMinutes },
    );
    logger.info("run.step_finished", {
      ...fields,
      outcome: execution.outcome,
      summary: execution.output.summary,
    });
    if (action.kind === "finish") {
      logger.info("run.finished", { ...fields, status: action.status });
      return { kind: "finished", status: action.status };
    }
  }
}
