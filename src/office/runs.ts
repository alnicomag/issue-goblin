/**
 * 実行(`runs`)とステップ(`steps`)の記録と、再開。
 *
 * 進み方の判断は `run-steps.ts` の純粋関数に任せ、ここでは記録だけを行う。
 * どの関数も、同じ呼び出しを2回行っても行が重複しない。
 */
import { z } from "zod";
import { type Clock, isoNow } from "./clock.ts";
import type { Db } from "./db.ts";
import { utcDayStart } from "./intake.ts";
import {
  type NextAction,
  nextAction,
  nextRetryAt,
  STEP_NAMES,
  STEP_OUTCOMES,
  type StepName,
  type StepOutcome,
} from "./run-steps.ts";

export const RUN_STATUSES = [
  "running",
  "done",
  "question",
  "failed",
  "held",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** ステップの状態。終わったステップは、その結果(`StepOutcome`)を状態として持つ。 */
export const STEP_STATUSES = [
  "running",
  ...STEP_OUTCOMES,
  "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

const RunRowSchema = z
  .object({
    id: z.number().int(),
    repo: z.string(),
    issue_number: z.number().int(),
    attempt: z.number().int().min(1),
    status: z.enum(RUN_STATUSES),
    current_step: z.enum(STEP_NAMES).nullable(),
    started_at: z.string(),
    finished_at: z.string().nullable(),
    next_retry_at: z.string().nullable(),
  })
  .transform((row) => ({
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    attempt: row.attempt,
    status: row.status,
    currentStep: row.current_step,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextRetryAt: row.next_retry_at,
  }));
export type Run = z.infer<typeof RunRowSchema>;

const StepRowSchema = z
  .object({
    id: z.number().int(),
    run_id: z.number().int(),
    name: z.enum(STEP_NAMES),
    status: z.enum(STEP_STATUSES),
    output: z.string().nullable(),
    interrupted_log_paths: z
      .string()
      .nullable()
      .transform((text, context): string[] => {
        if (text === null) return [];
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          raw = undefined;
        }
        const paths = z.array(z.string()).safeParse(raw);
        if (!paths.success) {
          context.addIssue({
            code: "custom",
            message: "パスの配列(JSON)ではありません",
          });
          return z.NEVER;
        }
        return paths.data;
      }),
    started_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .transform((row) => ({
    id: row.id,
    runId: row.run_id,
    name: row.name,
    status: row.status,
    /** チェックポイントの内容(JSONの文字列)。 */
    output: row.output,
    /** 事務局の停止で中断した呼び出しの、ログの場所(古い順)。 */
    interruptedLogPaths: row.interrupted_log_paths,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
export type Step = z.infer<typeof StepRowSchema>;

const RUN_COLUMNS =
  "id, repo, issue_number, attempt, status, current_step, started_at, finished_at, next_retry_at";
const STEP_COLUMNS =
  "id, run_id, name, status, output, interrupted_log_paths, started_at, finished_at";

function parseRun(row: unknown): Run {
  const result = RunRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error("runs の行が想定外の内容です", { cause: result.error });
  }
  return result.data;
}

function parseStep(row: unknown): Step {
  const result = StepRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error("steps の行が想定外の内容です", { cause: result.error });
  }
  return result.data;
}

export function getRun(db: Db, runId: number): Run {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
    .get(runId);
  if (row === undefined) {
    throw new Error(`実行がありません: ${runId}`);
  }
  return parseRun(row);
}

/** 実行のステップを、記録した順に返す。 */
export function listSteps(db: Db, runId: number): Step[] {
  return db
    .prepare(`SELECT ${STEP_COLUMNS} FROM steps WHERE run_id = ? ORDER BY id`)
    .all(runId)
    .map(parseStep);
}

/**
 * 次の実行の試行回数。
 * 数えるのは `failed` で終わった実行だけで、質問での終了と取り消しは数えない。
 * `resetAttempts` でリセットされた失敗も数えない。
 */
export function nextAttempt(db: Db, repo: string, issueNumber: number): number {
  return countFailedRuns(db, repo, issueNumber) + 1;
}

/** 試行に数える失敗(`failed` で終わり、リセットされていない実行)の数。 */
export function countFailedRuns(
  db: Db,
  repo: string,
  issueNumber: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE repo = ? AND issue_number = ? AND status = 'failed'
         AND attempt_reset_at IS NULL`,
    )
    .get(repo, issueNumber) as { n: number };
  return row.n;
}

/**
 * イシューの試行回数をリセットする。人間が `failed` のイシューを戻したときに呼ぶ。
 *
 * それまでの失敗を試行に数えなくするだけで、実行の記録は消さない。次の実行は1回目になる。
 * 2回呼んでも、最初にリセットした時刻は変わらない。リセットした失敗の数を返す。
 *
 * `finishedUntil` を渡すと、その時刻までに終わった失敗だけをリセットする。
 * 人間がイシューを戻した後の失敗を、後から巻き込まないためである。
 */
export function resetAttempts(
  db: Db,
  clock: Clock,
  target: { repo: string; issueNumber: number; finishedUntil?: string },
): number {
  const info = db
    .prepare(
      `UPDATE runs SET attempt_reset_at = ?
       WHERE repo = ? AND issue_number = ? AND status = 'failed'
         AND attempt_reset_at IS NULL
         AND (? IS NULL OR finished_at <= ?)`,
    )
    .run(
      isoNow(clock),
      target.repo,
      target.issueNumber,
      target.finishedUntil ?? null,
      target.finishedUntil ?? null,
    );
  return info.changes;
}

/** イシューのすべての実行を、記録した順に返す。 */
export function listRunsOfIssue(
  db: Db,
  repo: string,
  issueNumber: number,
): Run[] {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE repo = ? AND issue_number = ? ORDER BY id`,
    )
    .all(repo, issueNumber)
    .map(parseRun);
}

/** イシューの最新の実行。なければ null。 */
export function latestRun(
  db: Db,
  repo: string,
  issueNumber: number,
): Run | null {
  const row = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE repo = ? AND issue_number = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(repo, issueNumber);
  return row === undefined ? null : parseRun(row);
}

/** `since`(UTCのISO 8601形式)以降に開始した実行の数。全リポジトリの合計で、再試行を含む。 */
export function countRunsStartedSince(db: Db, since: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?")
    .get(since) as { n: number };
  return row.n;
}

/**
 * `now` を含むUTCの1日に開始した実行の数。
 * 1日の上限(`daily_run_limit`)と比べる数で、着手のときも、状況表示も、これを使う。
 */
export function countRunsStartedToday(db: Db, now: Date): number {
  return countRunsStartedSince(db, utcDayStart(now));
}

/**
 * 失敗の後、次に再試行してよい時刻。待機がなければ null。
 * 試行に数える失敗のうち、最後のものの値を返す。
 */
export function retryNotBefore(
  db: Db,
  repo: string,
  issueNumber: number,
): string | null {
  const row = db
    .prepare(
      `SELECT next_retry_at FROM runs
       WHERE repo = ? AND issue_number = ? AND status = 'failed'
         AND attempt_reset_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repo, issueNumber) as { next_retry_at: string | null } | undefined;
  return row?.next_retry_at ?? null;
}

/** 実行に、作業場所、ブランチ、PRの番号を記録する。渡した項目だけを書く。 */
export function recordRunDetails(
  db: Db,
  runId: number,
  details: { workspacePath?: string; branch?: string; prNumber?: number },
): void {
  db.prepare(
    `UPDATE runs
     SET worktree_path = COALESCE(?, worktree_path),
         branch = COALESCE(?, branch),
         pr_number = COALESCE(?, pr_number)
     WHERE id = ?`,
  ).run(
    details.workspacePath ?? null,
    details.branch ?? null,
    details.prNumber ?? null,
    runId,
  );
}

/** 実行中の実行について、次に行うステップを返す。 */
export function nextStep(
  db: Db,
  runId: number,
): { step: StepName; interrupted: boolean } {
  const run = getRun(db, runId);
  if (run.status !== "running") {
    throw new Error(`実行 ${runId} は終わっています(${run.status})`);
  }
  return pendingStep(db, run);
}

/**
 * イシューに対する実行を始める。
 * そのイシューに実行中の実行がすでにあれば、新しく作らずにそれを返す。
 */
export function startRun(
  db: Db,
  clock: Clock,
  target: { repo: string; issueNumber: number },
): Run {
  return db
    .transaction((): Run => {
      const existing = db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM runs
           WHERE repo = ? AND issue_number = ? AND status = 'running'`,
        )
        .get(target.repo, target.issueNumber);
      if (existing !== undefined) {
        return parseRun(existing);
      }
      const info = db
        .prepare(
          `INSERT INTO runs (repo, issue_number, attempt, status, started_at)
           VALUES (?, ?, ?, 'running', ?)`,
        )
        .run(
          target.repo,
          target.issueNumber,
          nextAttempt(db, target.repo, target.issueNumber),
          isoNow(clock),
        );
      return getRun(db, Number(info.lastInsertRowid));
    })
    .immediate();
}

/** 実行中の実行について、次に行うステップを `steps` の記録から決める。 */
function pendingStep(
  db: Db,
  run: Run,
): { step: StepName; interrupted: boolean } {
  const steps = listSteps(db, run.id);
  const last = steps.at(-1);
  if (last?.status === "running") {
    return { step: last.name, interrupted: true };
  }
  const action = actionAfter(steps, last);
  if (action.kind !== "run_step") {
    throw new Error(
      `実行 ${run.id} は ${action.status} で終わっているはずですが、実行中のままです`,
    );
  }
  return { step: action.step, interrupted: false };
}

/** `finished` が終わった後に行うこと。`steps` は、その実行のステップを記録した順に並べたもの。 */
function actionAfter(
  steps: readonly Step[],
  finished: Step | undefined,
): NextAction {
  if (finished === undefined) {
    return nextAction({ reworkCount: 0 }, null);
  }
  if (finished.status === "running" || finished.status === "cancelled") {
    throw new Error(
      `ステップ ${finished.name} は終わっていません(${finished.status})`,
    );
  }
  const reworkCount = steps.filter(
    (step) => step.status === "rework" && step.id < finished.id,
  ).length;
  return nextAction(
    { reworkCount },
    { step: finished.name, outcome: finished.status },
  );
}

/**
 * ステップの開始を記録する。
 *
 * 同じステップが実行中のまま残っていれば(事務局が落ちた場合)、その行を使う。
 * 進み方に合わないステップは、記録せずにエラーにする。
 */
export function startStep(
  db: Db,
  clock: Clock,
  runId: number,
  step: StepName,
): Step {
  return db
    .transaction((): Step => {
      const run = getRun(db, runId);
      if (run.status !== "running") {
        throw new Error(
          `実行 ${runId} は終わっています(${run.status})。ステップを始められません`,
        );
      }
      const pending = pendingStep(db, run);
      if (pending.step !== step) {
        throw new Error(
          `実行 ${runId} の次のステップは ${pending.step} です。${step} は始められません`,
        );
      }
      if (!pending.interrupted) {
        db.prepare(
          `INSERT INTO steps (run_id, name, status, started_at)
           VALUES (?, ?, 'running', ?)`,
        ).run(runId, step, isoNow(clock));
        db.prepare("UPDATE runs SET current_step = ? WHERE id = ?").run(
          step,
          runId,
        );
      }
      const started = listSteps(db, runId).at(-1);
      if (started === undefined) {
        throw new Error(`ステップ ${step} を記録できませんでした`);
      }
      return started;
    })
    .immediate();
}

/**
 * 中断した呼び出しのログの場所を、実行中のステップに足す。
 *
 * ステップの状態と結果は変えない(実行中のまま残り、次の起動でやり直す)。
 * 同じ場所がすでにあれば、何もしない。
 */
export function recordInterruptedLog(
  db: Db,
  runId: number,
  step: StepName,
  logPath: string,
): void {
  db.transaction(() => {
    const last = listSteps(db, runId).at(-1);
    if (last === undefined || last.name !== step || last.status !== "running") {
      throw new Error(
        `実行 ${runId} のステップ ${step} は実行中ではありません。中断のログを記録できません`,
      );
    }
    if (last.interruptedLogPaths.includes(logPath)) return;
    db.prepare("UPDATE steps SET interrupted_log_paths = ? WHERE id = ?").run(
      JSON.stringify([...last.interruptedLogPaths, logPath]),
      last.id,
    );
  }).immediate();
}

export interface StepFinish {
  readonly runId: number;
  readonly step: StepName;
  readonly outcome: StepOutcome;
  /** チェックポイントの内容。JSONにして `output` に残す。 */
  readonly output?: unknown;
  readonly sessionId?: string;
  readonly costUsd?: number;
  readonly logPath?: string;
}

/**
 * ステップの終了を記録し、次に行うことを返す。
 *
 * 実行が終わる場合は、同じトランザクションの中で `runs` も終了にする。
 * 失敗で終わる場合は、次に再試行してよい時刻も記録する。
 * 同じ内容でもう一度呼ばれた場合は、何も書かずに同じ答えを返す。
 */
export function finishStep(
  db: Db,
  clock: Clock,
  finish: StepFinish,
  options: { retryWaitMinutes: readonly number[] },
): NextAction {
  const output =
    finish.output === undefined ? null : JSON.stringify(finish.output);
  return db
    .transaction((): NextAction => {
      const run = getRun(db, finish.runId);
      const steps = listSteps(db, finish.runId);
      const last = steps.at(-1);
      if (last === undefined || last.name !== finish.step) {
        throw new Error(
          `実行 ${finish.runId} のステップ ${finish.step} は始まっていません`,
        );
      }
      if (last.status !== "running") {
        if (last.status === finish.outcome && last.output === output) {
          return actionAfter(steps, last);
        }
        throw new Error(
          `実行 ${finish.runId} のステップ ${finish.step} は、別の結果(${last.status})で終わっています`,
        );
      }

      // あり得ない組み合わせ(prepare が差し戻しを返すなど)は、書く前にここで失敗する。
      const finished: Step = { ...last, status: finish.outcome, output };
      const action = actionAfter(steps, finished);

      const now = clock.now();
      db.prepare(
        `UPDATE steps
         SET status = ?, output = ?, session_id = ?, cost_usd = ?, log_path = ?, finished_at = ?
         WHERE id = ?`,
      ).run(
        finish.outcome,
        output,
        finish.sessionId ?? null,
        finish.costUsd ?? null,
        finish.logPath ?? null,
        now.toISOString(),
        last.id,
      );

      if (action.kind === "finish") {
        db.prepare(
          "UPDATE runs SET status = ?, finished_at = ? WHERE id = ?",
        ).run(action.status, now.toISOString(), run.id);
        if (action.status === "failed") {
          const failedCount = countFailedRuns(db, run.repo, run.issueNumber);
          db.prepare("UPDATE runs SET next_retry_at = ? WHERE id = ?").run(
            nextRetryAt(now, failedCount, options.retryWaitMinutes),
            run.id,
          );
        }
      }
      return action;
    })
    .immediate();
}

/**
 * 実行を取り消す。実行中のステップがあれば、それも取り消しにする。
 * すでに取り消されていれば何もしない。ほかの形で終わった実行は取り消せない。
 */
export function cancelRun(db: Db, clock: Clock, runId: number): void {
  db.transaction(() => {
    const run = getRun(db, runId);
    if (run.status === "cancelled") return;
    if (run.status !== "running") {
      throw new Error(
        `実行 ${runId} は終わっています(${run.status})。取り消せません`,
      );
    }
    const now = isoNow(clock);
    db.prepare(
      `UPDATE steps SET status = 'cancelled', finished_at = ?
       WHERE run_id = ? AND status = 'running'`,
    ).run(now, runId);
    db.prepare(
      "UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?",
    ).run(now, runId);
  }).immediate();
}

/** 人間の承認の記録。publish が `needs_approval` で止まったステップ1つにつき、1件まで。 */
export interface Approval {
  readonly id: number;
  readonly runId: number;
  /** 止まった publish のステップ。 */
  readonly stepId: number;
  /** 承認されたコミット。 */
  readonly headCommit: string;
  readonly createdAt: string;
  /** 実行を publish から再開した時刻。未使用なら null。 */
  readonly usedAt: string | null;
}

const ApprovalRowSchema = z
  .object({
    id: z.number().int(),
    run_id: z.number().int(),
    step_id: z.number().int(),
    head_commit: z.string().min(1),
    created_at: z.string(),
    used_at: z.string().nullable(),
  })
  .transform((row) => ({
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    headCommit: row.head_commit,
    createdAt: row.created_at,
    usedAt: row.used_at,
  }));

const APPROVAL_COLUMNS =
  "id, run_id, step_id, head_commit, created_at, used_at";

function parseApproval(row: unknown): Approval {
  const result = ApprovalRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error("approvals の行が想定外の内容です", {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * 実行が publish の人間の対応待ち(`held`)で終わっていれば、その止まったステップと、
 * その実行で止まった publish の数(今回を含む)を返す。そうでなければ null。
 */
export function heldPublishStep(
  db: Db,
  runId: number,
): { step: Step; count: number } | null {
  const steps = listSteps(db, runId);
  const last = steps.at(-1);
  if (last === undefined || last.name !== "publish" || last.status !== "held") {
    return null;
  }
  const count = steps.filter(
    (step) => step.name === "publish" && step.status === "held",
  ).length;
  return { step: last, count };
}

/** 止まったステップに対する承認。なければ null。 */
export function findApproval(db: Db, stepId: number): Approval | null {
  const row = db
    .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE step_id = ?`)
    .get(stepId);
  return row === undefined ? null : parseApproval(row);
}

/**
 * 人間の承認を記録する。
 *
 * 対象は、実行の最後のステップが、人間の対応待ちで止まった publish である場合だけである。
 * 同じステップの承認がすでにあれば、書かずにそれを返す(承認したコミットは変わらない)。
 */
export function recordApproval(
  db: Db,
  clock: Clock,
  input: { runId: number; headCommit: string },
): Approval {
  return db
    .transaction((): Approval => {
      const run = getRun(db, input.runId);
      const held = heldPublishStep(db, run.id);
      if (run.status !== "held" || held === null) {
        throw new Error(
          `実行 ${run.id} は、publish の人間の対応待ちで止まっていません(${run.status})。承認を記録できません`,
        );
      }
      const existing = findApproval(db, held.step.id);
      if (existing !== null) return existing;
      db.prepare(
        `INSERT INTO approvals
           (repo, issue_number, run_id, step_id, head_commit, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        run.repo,
        run.issueNumber,
        run.id,
        held.step.id,
        input.headCommit,
        isoNow(clock),
      );
      const created = findApproval(db, held.step.id);
      if (created === null) {
        throw new Error(`実行 ${run.id} の承認を記録できませんでした`);
      }
      return created;
    })
    .immediate();
}

/**
 * 承認された実行を、publish からやり直せるようにする。
 *
 * 実行を実行中に戻し、publish のステップを始め、承認を使用済みにする(1つのトランザクション)。
 * ほかのステップ(plan、implement など)は、やり直さない。承認したコミットを変えないためである。
 * 止まったステップに未使用の承認がなければ、エラーにする。
 * すでに再開してあれば(実行中で、最後の承認が使用済み)、何もしない。
 */
export function resumeApprovedRun(db: Db, clock: Clock, runId: number): Run {
  return db
    .transaction((): Run => {
      const run = getRun(db, runId);
      if (run.status === "running" && approvedCommit(db, runId) !== null) {
        return run;
      }
      const held = heldPublishStep(db, runId);
      if (run.status !== "held" || held === null) {
        throw new Error(
          `実行 ${runId} は、publish の人間の対応待ちで止まっていません(${run.status})。再開できません`,
        );
      }
      const approval = findApproval(db, held.step.id);
      if (approval === null || approval.usedAt !== null) {
        throw new Error(
          `実行 ${runId} には、未使用の承認がありません。再開できません`,
        );
      }
      const now = isoNow(clock);
      db.prepare(
        "UPDATE runs SET status = 'running', finished_at = NULL, current_step = 'publish' WHERE id = ?",
      ).run(runId);
      db.prepare(
        `INSERT INTO steps (run_id, name, status, started_at)
         VALUES (?, 'publish', 'running', ?)`,
      ).run(runId, now);
      db.prepare("UPDATE approvals SET used_at = ? WHERE id = ?").run(
        now,
        approval.id,
      );
      return getRun(db, runId);
    })
    .immediate();
}

/**
 * 実行の publish が通してよい、承認されたコミット。なければ null。
 * 使用済みの承認(その承認で実行を再開したもの)のうち、最後のものを返す。
 */
export function approvedCommit(db: Db, runId: number): string | null {
  const row = db
    .prepare(
      `SELECT head_commit FROM approvals
       WHERE run_id = ? AND used_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as { head_commit: string } | undefined;
  return row?.head_commit ?? null;
}

export interface ResumableRun {
  readonly run: Run;
  /** 次に行うステップ。 */
  readonly step: StepName;
  /** 実行中のまま残っていたステップをやり直す場合は true。 */
  readonly interrupted: boolean;
}

/**
 * 終わっていない実行と、それぞれの続きのステップを返す。起動時に呼ぶ。
 *
 * 続きは、最後に完了したステップの次。実行中のまま残ったステップがあれば、そのステップをやり直す。
 * 何も書かないので、再開しても試行回数は変わらない。
 */
export function findResumableRuns(db: Db): ResumableRun[] {
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running' ORDER BY id`,
    )
    .all()
    .map((row) => {
      const run = parseRun(row);
      return { run, ...pendingStep(db, run) };
    });
}
