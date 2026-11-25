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
 * 作業場所の後片付けは、実行の cleanup と同じく、`dry_run` の間は行わない。
 * 着手するはずだったイシューは、ログに出す(`intake.held`)。同じイシューを、毎回は出さない。
 * 着手前の確認(`preflight.ts`)も、`dry_run` の間は行わず、その結果も見ない。
 * 進めなかった実行も、行うはずだったこととあわせてログに出す(`run.held`)。同じ内容を、毎回は出さない。
 */
import { z } from "zod";
import {
  pendingChangeRequests,
  reopenForChangeRequests,
} from "./change-requests.ts";
import { isoNow } from "./clock.ts";
import { addIssueComment, removeLabel } from "./github.ts";
import { diffSection, ProtectedDiffSchema } from "./held-diff.ts";
import {
  type IntakeIssue,
  type IntakePlan,
  type IntakeRepo,
  planIntake,
} from "./intake.ts";
import type { RepoLocks } from "./locks.ts";
import { errorFields } from "./log.ts";
import { inlineCode, pathHitLines } from "./path-list.ts";
import type { PreflightGate } from "./preflight.ts";
import { readStoredFactoryYml } from "./product.ts";
import { advanceRun, type RunnerDeps } from "./runner.ts";
import {
  cancelRun,
  countFailedRuns,
  countRunsStartedToday,
  findApproval,
  findResumableRuns,
  heldPublishStep,
  latestRun,
  listRunsOfIssue,
  listSteps,
  type Run,
  recordApproval,
  resetAttempts,
  resumeApprovedRun,
  retryNotBefore,
  startRun,
} from "./runs.ts";
import { decideSettlement, type SettleAction } from "./settle.ts";
import { AGENT_APPROVED_LABEL, type Priority } from "./sync.ts";
import { applyTransition, type TransitionDeps } from "./transition-apply.ts";
import type { IssueState } from "./transitions.ts";
import { cleanupWorkspace, listWorkspaceIssues } from "./workspace.ts";
import { decideSweep } from "./workspace-sweep.ts";

export interface SupervisorDeps {
  readonly runner: RunnerDeps;
  /** 同期と同じ排他。 */
  readonly locks: RepoLocks;
  /** UTCの1日に着手する実行の数の上限(設定の `daily_run_limit`)。 */
  readonly dailyRunLimit: number;
  /** 設定の `dry_run`。 */
  readonly dryRun: boolean;
  /** 着手前の確認(製品の `commands.setup` が、ワーカーのイメージで通るか)。 */
  readonly preflight: PreflightGate;
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
  /** いま進めている実行と、着手前の確認が、すべて一区切りつくまで待つ。 */
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

/**
 * 人間の対応待ちのコメントに付ける目印。同じ知らせを、重ねて書かないために使う。
 *
 * `publishCount` は、その実行で止まった publish の数(今回を含む)。
 * 承認の後に再開した publish がまた止まった場合(2回目以降)は、回数を入れて、前の知らせと区別する。
 */
export function heldMarker(runId: number, publishCount = 1): string {
  return publishCount <= 1
    ? `<!-- factory:held run=${runId} -->`
    : `<!-- factory:held run=${runId} publish=${publishCount} -->`;
}

const PathHitSchema = z.object({ path: z.string(), pattern: z.string() });

/** publish が人間の対応待ちで止まったときの、チェックポイントの内容。 */
const HeldOutputSchema = z.object({
  status: z.enum(["needs_approval", "forbidden"]),
  headCommit: z.string().nullable(),
  forbidden: z.array(PathHitSchema),
  protected: z.array(PathHitSchema),
  /**
   * 保護対象のパスの差分(`needs_approval` のときだけ入る)。
   * 差分を残すようになる前の記録には、この項目がない。
   */
  protectedDiff: ProtectedDiffSchema.nullable().optional(),
});
export type HeldOutput = z.infer<typeof HeldOutputSchema>;

const HELD_EXPLANATIONS = {
  needs_approval: {
    what: "人間の承認が要るパス(`paths.protected`)に触れる変更があります。",
    next: (hasDiff: boolean) =>
      `承認するには、上のコミットの内容を確かめてから、このイシューにラベル \`${AGENT_APPROVED_LABEL}\` を付けてください。承認が効くのは、上のコミットだけです(このコメントより前に付いていたラベルは、外しました)。${
        hasDiff
          ? "コミットは push していません。保護対象のパスの差分を、このコメントの下に載せています。載せきれなかった分は、ファクトリーの作業場所で確かめます。"
          : "コミットは push していないので、内容は、ファクトリーの作業場所で確かめます。"
      }承認しない場合は、保護対象のパスを避ける方針をコメントするか、人間が作業を引き取ってください。`,
  },
  forbidden: {
    what: "ワーカーが変更してはいけないパス(`paths.forbidden`)に触れる変更があります。",
    next: () =>
      "禁止のパスを避ける方針をコメントするか、人間が作業を引き取ってください。",
  },
} as const;

/** GitHubのコメントの本文の、文字数の上限。 */
export const GITHUB_COMMENT_LIMIT = 65_536;

/**
 * 人間の対応待ちのコメントの本文。純粋関数で、同じ入力からは同じ本文になる。
 * `output` が null なら、記録から内容を読めなかったことを書く。
 *
 * `needs_approval` で、差分の記録があれば、保護対象のパスの差分を末尾(目印の前)に載せる。
 * 差分に使う長さは、ほかの部分の長さを引いて決めるので、本文はGitHubの上限に収まる。
 */
export function heldComment(
  runId: number,
  output: HeldOutput | null,
  publishCount = 1,
): string {
  const marker = heldMarker(runId, publishCount);
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
    lines.push(...pathHitLines(hits));
    const diff =
      output.status === "needs_approval"
        ? (output.protectedDiff ?? null)
        : null;
    lines.push(
      "",
      explanation.next(diff !== null),
      "イシューへのコメントは、次の実行のワーカーに渡ります。`state:ready` に戻すと、新しい実行として着手します。変更が同じなら、同じところで止まります。",
    );
    if (diff !== null) {
      // 差分の前後の空行、目印、書き込みのときに付く目印(`<!-- factory -->`)の分を残す。
      const used = lines.join("\n").length + marker.length + 100;
      lines.push("", ...diffSection(diff, GITHUB_COMMENT_LIMIT - used));
    }
  }
  lines.push("", marker);
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
  /**
   * `dry_run` のために着手を見送ったことを、すでにログに出したイシュー(リポジトリごとの番号)。
   * 同じ行を、ポーリングのたびに出さないために持つ。起動し直すと空になり、1回だけ出し直す。
   */
  const heldAnnounced = new Map<string, Set<number>>();
  /**
   * `dry_run` のために進めなかったことを、すでにログに出した実行と、そのとき行うはずだったこと
   * (リポジトリごとの、実行の番号から `action` への対応)。`heldAnnounced` と同じ目的で持つ。
   */
  const runHeldAnnounced = new Map<string, Map<number, SettleAction>>();

  /**
   * 枠がないために、修正依頼でのやり直しを見送ったことを、すでにログに出した実行と、その理由。
   * 同じ行を、ポーリングのたびに出さないために持つ。
   */
  const reworkDeferred = new Map<number, string>();

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
   * `before` は、コメントを書く直前に行うこと(すでにコメントがあれば、行わない)。
   */
  async function commentOnce(
    run: Run,
    marker: string,
    body: string,
    before?: () => Promise<void>,
  ): Promise<void> {
    const write = runner.writeFor(run.repo);
    const comments = await write.api.listCommentsOnIssue(
      run.repo,
      run.issueNumber,
    );
    if (comments.some((comment) => comment.body.includes(marker))) return;
    await before?.();
    await addIssueComment(write, run.repo, run.issueNumber, body);
  }

  /**
   * 承認のラベルを外し、DBの写しも合わせる。付いていなくても行う(やり直して安全)。
   *
   * 写しも合わせるのは、次の同期が、外す前の内容を承認と見誤らないためである(同期は、
   * 更新時刻が進んだ内容からだけ、ラベルの有無を読む)。同期と同じ排他の中で行う。
   */
  function dropApprovedLabel(run: Run): Promise<void> {
    return deps.locks.run(run.repo, async () => {
      const removed = await removeLabel(
        runner.writeFor(run.repo),
        run.repo,
        run.issueNumber,
        AGENT_APPROVED_LABEL,
      );
      if (!removed) return;
      db.prepare(
        "UPDATE issues SET approved = 0 WHERE repo = ? AND number = ?",
      ).run(run.repo, run.issueNumber);
    });
  }

  /** 止まった publish の記録を読む。読めなければ null。 */
  function readHeldOutput(run: Run): HeldOutput | null {
    const held = heldPublishStep(db, run.id);
    const parsed = HeldOutputSchema.safeParse(
      held?.step.output == null ? null : JSON.parse(held.step.output),
    );
    return parsed.success ? parsed.data : null;
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
    const output = readHeldOutput(run);
    if (output === null) {
      logger.warn("run.held_record_unreadable", fieldsOf(run));
    }
    const count = heldPublishStep(db, run.id)?.count ?? 1;
    await commentOnce(
      run,
      heldMarker(run.id, count),
      heldComment(run.id, output, count),
      // 承認が効くのは、このコメントより後に付いたラベルだけにする。
      // コメントがすでにあれば外さない(コメントを見た人間が付けたラベルかもしれない)。
      () => dropApprovedLabel(run),
    );
    await transition(
      run,
      "needs-info",
      "publish が人間の対応待ちで止まりました",
    );
  }

  /** 承認された実行を、publish から再開する。 */
  function resume(run: Run): void {
    const resumed = resumeApprovedRun(db, clock, run.id);
    logger.info("run.resumed_by_approval", fieldsOf(run));
    spawn(resumed);
  }

  /**
   * 人間の承認を受け取る。承認を記録し、ラベルを外し、`in-progress` に進めて、publish から再開する。
   *
   * 途中で止まっても、記録から続きが決まる。承認の記録は、止まったステップにつき1件で、
   * 承認したコミット(止まったときの先頭)は、やり直しても変わらない。
   */
  async function approve(run: Run): Promise<void> {
    const output = readHeldOutput(run);
    if (output?.status !== "needs_approval" || output.headCommit === null) {
      throw new Error(
        `実行 ${run.id} は、承認できる止まり方をしていません(記録: ${output?.status ?? "読めません"})`,
      );
    }
    const approval = recordApproval(db, clock, {
      runId: run.id,
      headCommit: output.headCommit,
    });
    logger.info("run.approved", {
      ...fieldsOf(run),
      head: approval.headCommit,
    });
    await dropApprovedLabel(run);
    const result = await transition(
      run,
      "in-progress",
      "人間が、保護対象のパスに触れる変更を承認しました",
    );
    if (result.status === "applied" || result.status === "unchanged") {
      resume(run);
    }
  }

  /**
   * 人間がPRに修正を依頼したので、`in-progress` に進めて、implement からやり直す。
   *
   * 状態を進めてから、やり直しを始める。その間で止まっても、`in-progress` でクローズ待ちの実行に
   * 未使用の依頼が残るので、記録から同じ答えが出て、続きから進む(`settle.ts`)。
   * 依頼は、やり直しを始めるときに使用済みにするので、同じ依頼で2回はやり直さない。
   */
  async function rework(run: Run): Promise<void> {
    const result = await transition(
      run,
      "in-progress",
      "人間がPRに修正を依頼しました",
    );
    if (result.status !== "applied" && result.status !== "unchanged") return;
    const reopened = reopenForChangeRequests(db, clock, run.id);
    logger.info("run.reworked_by_request", {
      ...fieldsOf(run),
      reviews: reopened.requests.map((request) => request.reviewId),
    });
    spawn(reopened.run);
  }

  /**
   * 修正依頼でのやり直しを始める枠があるか。なければ、理由を返す。
   *
   * やり直しは implement と review でClaudeを呼ぶので、着手と同じ枠(`limits.max_parallel` と、
   * 1日の実行数の上限)を通す。枠がなければ、イシューは `in-review` のまま待つ。
   */
  function reworkBlocker(repo: string): "no_slot" | "daily_limit" | null {
    const active = findResumableRuns(db).filter(
      (entry) => entry.run.repo === repo && entry.step !== "cleanup",
    ).length;
    if (active >= readStoredFactoryYml(db, repo).limits.max_parallel) {
      return "no_slot";
    }
    if (countRunsStartedToday(db, clock.now()) >= deps.dailyRunLimit) {
      return "daily_limit";
    }
    return null;
  }

  /**
   * クローズ待ちの実行について、修正依頼の有無と、やり直しを始める枠を調べる。
   * 枠がなくて見送るときは、理由が変わったときだけ、ログに出す。
   */
  function changeRequestInfo(
    run: Run,
    issueState: string,
  ): { pending: boolean; slot: boolean } {
    const pending =
      pendingChangeRequests(db, run.repo, run.issueNumber).length > 0;
    // 枠を調べるのは、使うときだけにする(factory.yml が不正でも、ほかの処理を止めない)。
    if (!pending || issueState !== "in-review") {
      reworkDeferred.delete(run.id);
      return { pending, slot: false };
    }
    const blocker = reworkBlocker(run.repo);
    if (blocker === null) {
      reworkDeferred.delete(run.id);
    } else if (reworkDeferred.get(run.id) !== blocker) {
      reworkDeferred.set(run.id, blocker);
      logger.info("run.rework_deferred", { ...fieldsOf(run), reason: blocker });
    }
    return { pending, slot: blocker === null };
  }

  /**
   * 決まったことを行う。
   *
   * `dry_run` のために行わなかった場合は、`heldNow` に、実行と、行うはずだったことを入れる。
   * ログに出すのは、前に出したときと、行うはずだったことが違う場合だけである。
   */
  async function perform(
    action: SettleAction,
    run: Run,
    issueState: string,
    heldNow: Map<number, SettleAction>,
  ): Promise<void> {
    if (action === "none") return;
    if (action === "cancel") {
      cancel(run, issueState);
      return;
    }
    // ここから下は、GitHubに書くか、ワーカーを動かす。dry_run の間は行わない。
    if (dryRun) {
      if (runHeldAnnounced.get(run.repo)?.get(run.id) !== action) {
        logger.info("run.held", {
          ...fieldsOf(run),
          reason: "dry_run",
          action,
        });
      }
      heldNow.set(run.id, action);
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
      case "rework":
        await rework(run);
        return;
      case "ask":
        await ask(run);
        return;
      case "hold":
        await hold(run);
        return;
      case "approve":
        await approve(run);
        return;
      case "resume":
        resume(run);
        return;
      case "retry":
        await transition(run, "ready", "失敗しました。待機後に再試行します");
        return;
      case "give_up":
        await transition(run, "failed", "試行の上限に達しました");
        return;
    }
  }

  /** `held` で終わった実行の、止まった理由と、承認の記録。 */
  function heldInfo(run: Run): {
    reason: HeldOutput["status"] | null;
    approval: "none" | "pending" | "used";
  } {
    const held = heldPublishStep(db, run.id);
    const approval = held === null ? null : findApproval(db, held.step.id);
    return {
      reason: readHeldOutput(run)?.status ?? null,
      approval:
        approval === null
          ? "none"
          : approval.usedAt === null
            ? "pending"
            : "used",
    };
  }

  /**
   * リポジトリの中で、実行に関わるイシューを1件ずつ見て、行うべきことを行う。
   *
   * 見終えたら、`dry_run` のために進めなかった実行の覚えを、今回の分に置き換える。
   * 今回進めなかった実行に入らなかったもの(取り消した、対象から外れた)は、出したことを忘れる
   * (もう一度対象になったら、もう一度出す)。呼ばれなかったリポジトリ(同期できなかったもの)の
   * 分は、そのまま覚えておく。
   */
  async function reconcile(repo: string): Promise<void> {
    const rows = db
      .prepare(
        `SELECT number, state, approved FROM issues
         WHERE repo = ?
           AND (state = 'in-progress'
                OR EXISTS (SELECT 1 FROM runs
                           WHERE runs.repo = issues.repo
                             AND runs.issue_number = issues.number
                             AND runs.status = 'running')
                -- 人間の承認を待っているもの。ラベルが付いたか、承認を記録した後で止まっていた。
                OR (state = 'needs-info'
                    AND (approved = 1
                         OR EXISTS (SELECT 1 FROM approvals
                                    WHERE approvals.repo = issues.repo
                                      AND approvals.issue_number = issues.number
                                      AND approvals.used_at IS NULL))))
         ORDER BY number`,
      )
      .all(repo) as { number: number; state: string; approved: number }[];
    const heldNow = new Map<number, SettleAction>();
    if (rows.length === 0) {
      runHeldAnnounced.set(repo, heldNow);
      return;
    }

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
            ...(run.status === "held" ? { held: heldInfo(run) } : {}),
          },
          // 修正依頼を見るのは、PRを作ってクローズを待っている実行だけである。
          ...(pending?.step === "cleanup"
            ? { changeRequest: changeRequestInfo(run, row.state) }
            : {}),
          approvedLabel: row.approved !== 0,
          active: tasks.has(run.id),
          failedCount: countFailedRuns(db, repo, row.number),
          // 上限を読むのは、使うときだけにする(factory.yml が不正でも、ほかの処理を止めない)。
          maxAttempts: needsLimit
            ? readStoredFactoryYml(db, repo).limits.max_attempts
            : 1,
        });
        await perform(action, run, row.state, heldNow);
      } catch (error) {
        logger.error("run.settle_failed", {
          repo,
          issue: row.number,
          ...errorFields(error),
        });
      }
    }
    runHeldAnnounced.set(repo, heldNow);
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

  /**
   * 実行の cleanup に届かなかった作業場所を、片付ける。
   *
   * 実際にある作業場所を並べ、消すか残すかを、記録だけから決める(`workspace-sweep.ts`)。
   * 何度行っても、結果は変わらない。gitは実行せず、ミラーには触れない。
   *
   * 片付けられなかったイシューを返す。`all` は、作業場所を並べられなかった場合。
   * 前の作業場所のまま次の実行を始めないように、呼び出し側は、そのイシューに着手しない。
   */
  function sweepWorkspaces(repo: string): Set<number> | "all" {
    let issues: number[];
    try {
      issues = listWorkspaceIssues(runner.dirs, repo);
    } catch (error) {
      logger.error("workspace.sweep_failed", { repo, ...errorFields(error) });
      return "all";
    }
    const failed = new Set<number>();
    for (const issue of issues) {
      try {
        const row = db
          .prepare("SELECT state FROM issues WHERE repo = ? AND number = ?")
          .get(repo, issue) as { state: string } | undefined;
        const returned = db
          .prepare(
            `SELECT MAX(created_at) AS at FROM events
             WHERE type IN ('issue.state_changed', 'issue.closed')
               AND json_extract(payload, '$.from') = 'failed'
               AND repo = ? AND issue_number = ?`,
          )
          .get(repo, issue) as { at: string | null };
        const issueRuns = listRunsOfIssue(db, repo, issue);
        const decision = decideSweep({
          issueState: row?.state ?? null,
          runs: issueRuns,
          active: issueRuns.some((run) => tasks.has(run.id)),
          returnedFromFailedAt: returned.at,
        });
        if (decision === "keep") continue;
        cleanupWorkspace({ dirs: runner.dirs, repo, issue });
        logger.info("workspace.removed", {
          repo,
          issue,
          reason:
            decision === "remove_closed" ? "closed" : "returned_from_failed",
        });
      } catch (error) {
        failed.add(issue);
        logger.error("workspace.sweep_failed", {
          repo,
          issue,
          ...errorFields(error),
        });
      }
    }
    return failed;
  }

  /**
   * `ready` のイシューから、着手するものを決める。記録もGitHubも変えない。
   * `unswept` にあるイシュー(作業場所を片付けられなかったもの)は、候補にしない。
   *
   * `usePreflight` が true なら、着手前の確認が通っていない製品のイシューを、候補から外す。
   * false なら、確認の結果を見ない(`dry_run` の間。確認そのものを行わないため)。
   */
  function planStarts(
    repos: readonly string[],
    unswept: ReadonlyMap<string, Set<number> | "all">,
    usePreflight: boolean,
  ): IntakePlan<IntakeIssue> {
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
          preflight: usePreflight ? deps.preflight.statusOf(repo) : "passed",
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
        const blocked = unswept.get(repo);
        if (blocked === "all" || blocked?.has(row.number) === true) {
          logger.warn("intake.issue_skipped", {
            repo,
            issue: row.number,
            reason: "作業場所を片付けられなかったので、今回は着手しません",
          });
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
    if (issues.length === 0) return { starts: [], skipped: [] };

    const now = clock.now();
    return planIntake({
      issues,
      repos: intakeRepos,
      dailyLimit: deps.dailyRunLimit,
      startedToday: countRunsStartedToday(db, now),
      now,
    });
  }

  /**
   * `ready` のイシューから、着手するものを決めて、着手する。
   * `unswept` にあるイシュー(作業場所を片付けられなかったもの)には、着手しない。
   *
   * 着手前の確認が済んでいないために外した製品は、確認を裏で始める(終わるのを待たない)。
   * 確認が終われば、後のポーリングで着手する。通らなかった製品のイシューは、`ready` のまま残る。
   */
  async function intake(
    repos: readonly string[],
    unswept: ReadonlyMap<string, Set<number> | "all">,
  ): Promise<void> {
    const plan = planStarts(repos, unswept, true);
    for (const repo of new Set(
      plan.skipped
        .filter(({ reason }) => reason === "preflight_pending")
        .map(({ issue }) => issue.repo),
    )) {
      deps.preflight.ensure(repo);
    }
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

  /**
   * `dry_run` のために見送った着手を、ログに出す。記録もGitHubも変えない。
   *
   * 出すのは、`dry_run` でなければ今回着手したイシューで、まだ出していないものだけである。
   * 着手の対象から外れたイシューは、出したことを忘れる(もう一度対象になったら、もう一度出す)。
   * 今回渡されなかったリポジトリ(同期できなかったもの)の分は、そのまま覚えておく。
   */
  function announceHeldStarts(repos: readonly string[]): void {
    const plan = planStarts(repos, new Map(), false);
    for (const repo of repos) {
      const planned = new Set(
        plan.starts
          .filter((issue) => issue.repo === repo)
          .map((issue) => issue.number),
      );
      const announced = heldAnnounced.get(repo) ?? new Set<number>();
      for (const issue of plan.starts) {
        if (issue.repo !== repo || announced.has(issue.number)) continue;
        logger.info("intake.held", {
          repo,
          issue: issue.number,
          priority: issue.priority,
          reason: "dry_run",
        });
      }
      heldAnnounced.set(repo, planned);
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
      if (stopping) return;
      if (dryRun) {
        announceHeldStarts(repos);
        return;
      }
      // 着手の前に片付ける。人間が failed から戻したイシューの次の実行が、最新から始まるようにする。
      const unswept = new Map<string, Set<number> | "all">();
      for (const repo of repos) {
        const failed = sweepWorkspaces(repo);
        if (failed === "all" || failed.size > 0) unswept.set(repo, failed);
      }
      await intake(repos, unswept);
    },

    async stop(graceMs) {
      stopping = true;
      const pending = [...tasks.values()];
      for (const task of pending) task.controller.abort();
      // 確かめている途中の、着手前の確認も止める。
      const preflightStopped = deps.preflight.stop();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      });
      const finished = Promise.all([
        preflightStopped,
        ...pending.map((task) => task.done),
      ]).then(() => true as const);
      const stopped = await Promise.race([finished, timeout]);
      clearTimeout(timer);
      return stopped;
    },

    async idle() {
      // 着手前の確認は、実行を始めない(始めるのは `tick` だけ)ので、先に待てば足りる。
      await deps.preflight.idle();
      while (tasks.size > 0) {
        await Promise.all([...tasks.values()].map((task) => task.done));
      }
    },

    activeRunIds() {
      return [...tasks.keys()];
    },
  };
}
