/**
 * 実行の管理。着手、再開、取り消し、状態の変更を、記録に基づいて行う。
 *
 * 同期のたびに `tick` を呼ぶ。`tick` は、DBにある記録(GitHubの写しと、実行の記録)を見て、
 * 次に行うことを決まった規則(`settle.ts`、`intake.ts`)で決める。判断は持たない。
 *
 * 実行そのもの(ステップ)は、`tick` の外で進む。ステップは長くかかるので、
 * 待っている間も、同期と、人間による変更への追従を続けるためである。
 * 1つの実行で起きた失敗は、その実行の中にとどめる。
 *
 * `dry_run` の間は、着手も、実行を進めることも、状態の変更もしない。
 * ラベルを書けないと、GitHubから見えないところで作業が進むことになるからである。
 * 人間が状態を変えた実行の取り消しと、試行回数のリセットは、DBだけの操作なので行う。
 */
import { z } from "zod";
import { isoNow } from "./clock.ts";
import { addIssueComment } from "./github.ts";
import { type IntakeIssue, type IntakeRepo, planIntake } from "./intake.ts";
import type { RepoLocks } from "./locks.ts";
import { errorFields } from "./log.ts";
import { readStoredFactoryYml } from "./product.ts";
import { advanceRun, type RunnerDeps } from "./runner.ts";
import {
  cancelRun,
  countFailedRuns,
  countRunsStartedToday,
  findResumableRuns,
  latestRun,
  listSteps,
  type Run,
  resetAttempts,
  retryNotBefore,
  startRun,
} from "./runs.ts";
import { decideSettlement, type SettleAction } from "./settle.ts";
import type { Priority } from "./sync.ts";
import { applyTransition, type TransitionDeps } from "./transition-apply.ts";
import type { IssueState } from "./transitions.ts";

export interface SupervisorDeps {
  readonly runner: RunnerDeps;
  /** 同期と同じ排他。 */
  readonly locks: RepoLocks;
  /** UTCの1日に着手する実行の数の上限(設定の `daily_run_limit`)。 */
  readonly dailyRunLimit: number;
  /** 設定の `dry_run`。 */
  readonly dryRun: boolean;
}

export interface Supervisor {
  /**
   * 記録を見て、行うべきことを行う。同期の後に呼ぶ。
   * `repos` には、今回の同期に成功したリポジトリを、設定に書いた順で渡す。
   * 同期できなかったリポジトリは、写しが古いかもしれないので、今回は触らない。
   */
  tick(repos: readonly string[]): Promise<void>;
  /**
   * 進めている実行を止める。実行中のステップは、そのまま残る(次の起動でやり直す)。
   * `graceMs` の間に全部が止まれば true。
   */
  stop(graceMs: number): Promise<boolean>;
  /** いま進めている実行が、すべて一区切りつくまで待つ。 */
  idle(): Promise<void>;
  /** いま進めている実行の番号。 */
  activeRunIds(): number[];
}

/** 質問のコメントに付ける目印。同じ実行の質問を、重ねて書かないために使う。 */
export function questionMarker(runId: number): string {
  return `<!-- factory:question run=${runId} -->`;
}

/** 質問のコメントの本文。 */
export function questionComment(runId: number, question: string): string {
  return [
    "作業を進める前に、確認したいことがあります。",
    "",
    question.trim(),
    "",
    questionMarker(runId),
  ].join("\n");
}

/** 人間の対応待ちのコメントに付ける目印。同じ実行の知らせを、重ねて書かないために使う。 */
export function heldMarker(runId: number): string {
  return `<!-- factory:held run=${runId} -->`;
}

/** 人間の対応待ちのコメントに挙げるパスの数の上限。残りは件数だけを書く。 */
export const HELD_COMMENT_PATH_LIMIT = 50;

const PathHitSchema = z.object({ path: z.string(), pattern: z.string() });

/** publish が人間の対応待ちで止まったときの、チェックポイントの内容。 */
const HeldOutputSchema = z.object({
  status: z.enum(["needs_approval", "forbidden"]),
  headCommit: z.string().nullable(),
  forbidden: z.array(PathHitSchema),
  protected: z.array(PathHitSchema),
});
export type HeldOutput = z.infer<typeof HeldOutputSchema>;

/**
 * パスやパターンを、コメントのコードの中に書ける形にする。
 *
 * パスはワーカーが決められる文字列なので、コードの外に抜け出す書き方(バッククォート、改行)と、
 * 目印に見える書き方(HTMLコメントの始まり)を崩す。コードの中なので、メンションは通知にならない。
 */
function inlineCode(text: string): string {
  const safe = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を空白に置き換える
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("`", "'")
    .replaceAll("<!--", "＜!--");
  return `\`${safe}\``;
}

const HELD_EXPLANATIONS = {
  needs_approval: {
    what: "人間の承認が要るパス(`paths.protected`)に触れる変更があります。",
    next: "承認を受け取ってPRにする仕組みは、まだありません。保護対象のパスを避ける方針をコメントするか、人間が作業を引き取ってください。",
  },
  forbidden: {
    what: "ワーカーが変更してはいけないパス(`paths.forbidden`)に触れる変更があります。",
    next: "禁止のパスを避ける方針をコメントするか、人間が作業を引き取ってください。",
  },
} as const;

/**
 * 人間の対応待ちのコメントの本文。純粋関数で、同じ入力からは同じ本文になる。
 * `output` が null なら、記録から内容を読めなかったことを書く。
 */
export function heldComment(runId: number, output: HeldOutput | null): string {
  const lines = [
    "PRを作る前の検査で止まりました。push もPRの作成もしていません。人間の対応を待ちます。自動では再試行しません。",
    "",
  ];
  if (output === null) {
    lines.push(
      "(止まった理由を記録から読めませんでした。実行のログを確認してください)",
    );
  } else {
    const explanation = HELD_EXPLANATIONS[output.status];
    const hits =
      output.status === "forbidden" ? output.forbidden : output.protected;
    lines.push(
      `- 結果: \`${output.status}\``,
      `- 理由: ${explanation.what}`,
      `- コミット: ${output.headCommit === null ? "(なし)" : inlineCode(output.headCommit)}`,
      "",
      `当たったパス(${hits.length} 件):`,
      "",
    );
    for (const hit of hits.slice(0, HELD_COMMENT_PATH_LIMIT)) {
      lines.push(
        `- ${inlineCode(hit.path)}(パターン: ${inlineCode(hit.pattern)})`,
      );
    }
    const rest = hits.length - HELD_COMMENT_PATH_LIMIT;
    if (rest > 0) lines.push(`- (ほか ${rest} 件)`);
    lines.push(
      "",
      explanation.next,
      "イシューへのコメントは、次の実行のワーカーに渡ります。`state:ready` に戻すと、新しい実行として着手します。変更が同じなら、同じところで止まります。",
    );
  }
  lines.push("", heldMarker(runId));
  return lines.join("\n");
}

const PrioritySchema = z.enum(["p0", "p1", "p2", "p3"]).nullable();

interface ReadyRow {
  repo: string;
  number: number;
  state: string;
  priority: string | null;
  author: string | null;
  agent_skip: number;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { runner, dryRun } = deps;
  const { db, clock, logger } = runner;
  const tasks = new Map<
    number,
    { controller: AbortController; done: Promise<void> }
  >();
  let stopping = false;

  const transitionDeps = (repo: string): TransitionDeps => ({
    db,
    write: runner.writeFor(repo),
    clock,
    locks: deps.locks,
  });

  const transition = (run: Run, to: IssueState, reason: string) =>
    applyTransition(transitionDeps(run.repo), {
      repo: run.repo,
      issue: run.issueNumber,
      to,
      reason,
    });

  const fieldsOf = (run: Run) => ({
    repo: run.repo,
    issue: run.issueNumber,
    run: run.id,
  });

  /** 実行を、`tick` の外で進める。すでに進めていれば何もしない。 */
  function spawn(run: Run): void {
    if (stopping || tasks.has(run.id)) return;
    const controller = new AbortController();
    const done = advanceRun(runner, run.id, controller.signal)
      .then((result) => {
        logger.info("run.paused", { ...fieldsOf(run), result: result.kind });
      })
      .catch((error: unknown) => {
        // 1つの実行の失敗で、ほかの処理を止めない。記録は残っているので、次の tick でやり直す。
        logger.error("run.crashed", {
          ...fieldsOf(run),
          ...errorFields(error),
        });
      })
      .finally(() => {
        tasks.delete(run.id);
      });
    tasks.set(run.id, { controller, done });
  }

  function cancel(run: Run, issueState: string): void {
    cancelRun(db, clock, run.id);
    tasks.get(run.id)?.controller.abort();
    logger.info("run.cancelled", {
      ...fieldsOf(run),
      reason: "人間がイシューの状態を変えました",
      state: issueState,
    });
  }

  /** `in-progress` に進めて、実行を進める。 */
  async function begin(run: Run): Promise<void> {
    const result = await transition(run, "in-progress", "着手");
    if (result.status === "applied" || result.status === "unchanged") {
      spawn(run);
    } else if (result.status === "rejected") {
      // 同期との間に、人間が状態を変えた。
      cancel(run, result.from);
    }
  }

  /**
   * 目印つきのコメントを、まだなければ書く。
   * コメントした後、状態を変える前に止まった場合に、同じコメントを重ねて書かないためである。
   */
  async function commentOnce(
    run: Run,
    marker: string,
    body: string,
  ): Promise<void> {
    const write = runner.writeFor(run.repo);
    const comments = await write.api.listCommentsOnIssue(
      run.repo,
      run.issueNumber,
    );
    if (comments.some((comment) => comment.body.includes(marker))) return;
    await addIssueComment(write, run.repo, run.issueNumber, body);
  }

  /** 質問をコメントして、`needs-info` に進める。 */
  async function ask(run: Run): Promise<void> {
    const asked = listSteps(db, run.id).findLast(
      (step) => step.status === "question",
    );
    const output: unknown =
      asked?.output == null ? null : JSON.parse(asked.output);
    const summary = (output as { summary?: unknown } | null)?.summary;
    const question =
      typeof summary === "string" && summary.trim() !== ""
        ? summary
        : "(質問の内容を記録から読めませんでした。実行のログを確認してください)";

    await commentOnce(
      run,
      questionMarker(run.id),
      questionComment(run.id, question),
    );
    await transition(run, "needs-info", "ワーカーが質問を返しました");
  }

  /** publish が止まった理由をコメントして、`needs-info` に進める。 */
  async function hold(run: Run): Promise<void> {
    const stopped = listSteps(db, run.id).findLast(
      (step) => step.name === "publish" && step.status === "held",
    );
    const parsed = HeldOutputSchema.safeParse(
      stopped?.output == null ? null : JSON.parse(stopped.output),
    );
    if (!parsed.success) {
      logger.warn("run.held_record_unreadable", {
        ...fieldsOf(run),
        ...errorFields(parsed.error),
      });
    }
    await commentOnce(
      run,
      heldMarker(run.id),
      heldComment(run.id, parsed.success ? parsed.data : null),
    );
    await transition(
      run,
      "needs-info",
      "publish が人間の対応待ちで止まりました",
    );
  }

  async function perform(
    action: SettleAction,
    run: Run,
    issueState: string,
  ): Promise<void> {
    if (action === "none") return;
    if (action === "cancel") {
      cancel(run, issueState);
      return;
    }
    // ここから下は、GitHubに書くか、ワーカーを動かす。dry_run の間は行わない。
    if (dryRun) {
      logger.info("run.held", {
        ...fieldsOf(run),
        reason: "dry_run",
        action,
      });
      return;
    }
    switch (action) {
      case "begin":
        await begin(run);
        return;
      case "advance":
        spawn(run);
        return;
      case "to_review":
        await transition(run, "in-review", "PRを作成しました");
        return;
      case "ask":
        await ask(run);
        return;
      case "hold":
        await hold(run);
        return;
      case "retry":
        await transition(run, "ready", "失敗しました。待機後に再試行します");
        return;
      case "give_up":
        await transition(run, "failed", "試行の上限に達しました");
        return;
    }
  }

  /** リポジトリの中で、実行に関わるイシューを1件ずつ見て、行うべきことを行う。 */
  async function reconcile(repo: string): Promise<void> {
    const rows = db
      .prepare(
        `SELECT number, state FROM issues
         WHERE repo = ?
           AND (state = 'in-progress'
                OR EXISTS (SELECT 1 FROM runs
                           WHERE runs.repo = issues.repo
                             AND runs.issue_number = issues.number
                             AND runs.status = 'running'))
         ORDER BY number`,
      )
      .all(repo) as { number: number; state: string }[];
    if (rows.length === 0) return;

    const resumable = new Map(
      findResumableRuns(db)
        .filter((entry) => entry.run.repo === repo)
        .map((entry) => [entry.run.issueNumber, entry]),
    );
    for (const row of rows) {
      try {
        const pending = resumable.get(row.number);
        const run = pending?.run ?? latestRun(db, repo, row.number);
        if (run === null) continue;
        const needsLimit =
          run.status === "failed" && row.state === "in-progress";
        const action = decideSettlement({
          issueState: row.state,
          run: {
            status: run.status,
            nextStep: pending?.step ?? null,
            started: listSteps(db, run.id).length > 0,
          },
          active: tasks.has(run.id),
          failedCount: countFailedRuns(db, repo, row.number),
          // 上限を読むのは、使うときだけにする(factory.yml が不正でも、ほかの処理を止めない)。
          maxAttempts: needsLimit
            ? readStoredFactoryYml(db, repo).limits.max_attempts
            : 1,
        });
        await perform(action, run, row.state);
      } catch (error) {
        logger.error("run.settle_failed", {
          repo,
          issue: row.number,
          ...errorFields(error),
        });
      }
    }
  }

  /**
   * 人間が `failed` のイシューを戻したら、それまでの失敗を試行に数えなくする。
   *
   * 同期が記録した「`failed` からの変更」を見て、その時刻までの失敗をリセットする。
   * イベントは消費しない。何度行っても、結果は変わらない。
   */
  function resetReturnedIssues(): void {
    const rows = db
      .prepare(
        `SELECT repo, issue_number AS issue, MAX(created_at) AS at FROM events
         WHERE type IN ('issue.state_changed', 'issue.closed')
           AND json_extract(payload, '$.from') = 'failed'
           AND repo IS NOT NULL AND issue_number IS NOT NULL
         GROUP BY repo, issue_number`,
      )
      .all() as { repo: string; issue: number; at: string }[];
    for (const row of rows) {
      const count = resetAttempts(db, clock, {
        repo: row.repo,
        issueNumber: row.issue,
        finishedUntil: row.at,
      });
      if (count > 0) {
        logger.info("run.attempts_reset", {
          repo: row.repo,
          issue: row.issue,
          failures: count,
        });
      }
    }
  }

  /** `ready` のイシューから、着手するものを決めて、着手する。 */
  async function intake(repos: readonly string[]): Promise<void> {
    const running = findResumableRuns(db);
    const intakeRepos: IntakeRepo[] = [];
    for (const repo of repos) {
      try {
        const factoryYml = readStoredFactoryYml(db, repo);
        intakeRepos.push({
          repo,
          allowedAuthors: factoryYml.issues.allowed_authors,
          maxParallel: factoryYml.limits.max_parallel,
          // クローズを待っているだけの実行は、枠に数えない。
          active: running.filter(
            (entry) => entry.run.repo === repo && entry.step !== "cleanup",
          ).length,
        });
      } catch (error) {
        logger.warn("intake.repo_skipped", { repo, ...errorFields(error) });
      }
    }

    const issues: IntakeIssue[] = [];
    for (const repo of repos) {
      const rows = db
        .prepare(
          `SELECT repo, number, state, priority, author, agent_skip
           FROM issues WHERE repo = ? AND state = 'ready'`,
        )
        .all(repo) as ReadyRow[];
      for (const row of rows) {
        // 実行中の実行があるイシューは、着手の続きとして reconcile が扱う。
        if (
          running.some(
            (entry) =>
              entry.run.repo === repo && entry.run.issueNumber === row.number,
          )
        ) {
          continue;
        }
        issues.push({
          repo: row.repo,
          number: row.number,
          state: row.state,
          priority: PrioritySchema.parse(row.priority) as Priority | null,
          author: row.author,
          agentSkip: row.agent_skip !== 0,
          retryAt: retryNotBefore(db, row.repo, row.number),
        });
      }
    }
    if (issues.length === 0) return;

    const now = clock.now();
    const plan = planIntake({
      issues,
      repos: intakeRepos,
      dailyLimit: deps.dailyRunLimit,
      startedToday: countRunsStartedToday(db, now),
      now,
    });
    if (plan.skipped.length > 0) {
      const reasons: Record<string, number> = {};
      for (const { reason } of plan.skipped) {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      logger.info("intake.skipped", { at: isoNow(clock), reasons });
    }
    for (const issue of plan.starts) {
      if (stopping) return;
      try {
        const run = startRun(db, clock, {
          repo: issue.repo,
          issueNumber: issue.number,
        });
        logger.info("run.started", {
          ...fieldsOf(run),
          attempt: run.attempt,
          priority: issue.priority,
        });
        await begin(run);
      } catch (error) {
        // 記録は残っているので、次の tick が着手の続きを行う。
        logger.error("intake.start_failed", {
          repo: issue.repo,
          issue: issue.number,
          ...errorFields(error),
        });
      }
    }
  }

  return {
    async tick(repos) {
      if (stopping) return;
      resetReturnedIssues();
      for (const repo of repos) {
        if (stopping) return;
        try {
          await reconcile(repo);
        } catch (error) {
          logger.error("run.reconcile_failed", { repo, ...errorFields(error) });
        }
      }
      if (dryRun || stopping) return;
      await intake(repos);
    },

    async stop(graceMs) {
      stopping = true;
      const pending = [...tasks.values()];
      for (const task of pending) task.controller.abort();
      if (pending.length === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      });
      const finished = Promise.all(pending.map((task) => task.done)).then(
        () => true as const,
      );
      const stopped = await Promise.race([finished, timeout]);
      clearTimeout(timer);
      return stopped;
    },

    async idle() {
      while (tasks.size > 0) {
        await Promise.all([...tasks.values()].map((task) => task.done));
      }
    },

    activeRunIds() {
      return [...tasks.keys()];
    },
  };
}
