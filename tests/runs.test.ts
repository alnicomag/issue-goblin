import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/office/clock.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import type { StepName, StepOutcome } from "../src/office/run-steps.ts";
import {
  approvedCommit,
  cancelRun,
  countFailedRuns,
  countRunsStartedSince,
  countRunsStartedToday,
  findApproval,
  findResumableRuns,
  finishStep,
  getRun,
  heldPublishStep,
  heldStep,
  latestRun,
  listSteps,
  nextAttempt,
  nextStep,
  publishedHeads,
  recordApproval,
  recordInterruptedLog,
  recordRunDetails,
  resetAttempts,
  resumeApprovedRun,
  retryNotBefore,
  startRun,
  startStep,
} from "../src/office/runs.ts";

/** 進められる時計。 */
class FakeClock implements Clock {
  private current: Date;
  constructor(iso: string) {
    this.current = new Date(iso);
  }
  now(): Date {
    return this.current;
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const target = { repo: "owner/name", issueNumber: 7 };
const options = { retryWaitMinutes: [5, 30, 120] };

describe("実行とステップの記録", () => {
  let db: Db;
  let clock: FakeClock;

  beforeEach(() => {
    db = openDb(":memory:");
    clock = new FakeClock("2026-01-02T03:04:05.000Z");
    migrate(db, { clock });
  });

  const count = (table: "runs" | "steps"): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  /** ステップを1つ、開始から終了まで記録する。 */
  const record = (
    runId: number,
    step: StepName,
    outcome: StepOutcome = "done",
    output?: unknown,
  ) => {
    startStep(db, clock, runId, step);
    return finishStep(db, clock, { runId, step, outcome, output }, options);
  };

  /** 実行を1つ、prepare の失敗で終わらせる。 */
  const failRun = (issueNumber = target.issueNumber) => {
    const run = startRun(db, clock, { repo: target.repo, issueNumber });
    record(run.id, "prepare", "failed");
    return getRun(db, run.id);
  };

  describe("記録", () => {
    it("実行を始めると、実行中の行ができる", () => {
      const run = startRun(db, clock, target);
      expect(run).toMatchObject({
        repo: "owner/name",
        issueNumber: 7,
        attempt: 1,
        status: "running",
        currentStep: null,
        startedAt: "2026-01-02T03:04:05.000Z",
        finishedAt: null,
        nextRetryAt: null,
      });
    });

    it("ステップの開始と終了が steps に記録され、チェックポイントが output に残る", () => {
      const run = startRun(db, clock, target);

      clock.set("2026-01-02T03:05:00.000Z");
      const started = startStep(db, clock, run.id, "prepare");
      expect(started).toMatchObject({
        runId: run.id,
        name: "prepare",
        status: "running",
        output: null,
        startedAt: "2026-01-02T03:05:00.000Z",
        finishedAt: null,
      });
      expect(getRun(db, run.id).currentStep).toBe("prepare");

      clock.set("2026-01-02T03:06:00.000Z");
      const action = finishStep(
        db,
        clock,
        {
          runId: run.id,
          step: "prepare",
          outcome: "done",
          output: { path: "/work/owner/name/7" },
          logPath: "/logs/1.log",
        },
        options,
      );
      expect(action).toEqual({ kind: "run_step", step: "plan" });

      const row = db.prepare("SELECT * FROM steps").get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        run_id: run.id,
        name: "prepare",
        status: "done",
        started_at: "2026-01-02T03:05:00.000Z",
        finished_at: "2026-01-02T03:06:00.000Z",
        log_path: "/logs/1.log",
      });
      expect(JSON.parse(row.output as string)).toEqual({
        path: "/work/owner/name/7",
      });
    });

    it("Claudeのステップは、セッションと費用も残せる", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      startStep(db, clock, run.id, "plan");
      finishStep(
        db,
        clock,
        {
          runId: run.id,
          step: "plan",
          outcome: "done",
          output: { plan: "..." },
          sessionId: "session-1",
          costUsd: 0.25,
        },
        options,
      );
      expect(
        db
          .prepare("SELECT session_id, cost_usd FROM steps WHERE name = 'plan'")
          .get(),
      ).toEqual({ session_id: "session-1", cost_usd: 0.25 });
    });

    describe("中断した呼び出しのログ", () => {
      const startPlan = () => {
        const run = startRun(db, clock, target);
        record(run.id, "prepare");
        startStep(db, clock, run.id, "plan");
        return run;
      };
      const planOf = (runId: number) => {
        const step = listSteps(db, runId).at(-1);
        if (step === undefined) throw new Error("ステップがありません");
        return step;
      };

      it("記録がなければ、空である", () => {
        const run = startPlan();
        expect(planOf(run.id).interruptedLogPaths).toEqual([]);
      });

      it("実行中のステップに、ログの場所を足す。ステップは実行中のまま残る", () => {
        const run = startPlan();
        recordInterruptedLog(db, run.id, "plan", "/logs/a.log");
        recordInterruptedLog(db, run.id, "plan", "/logs/b.log");
        expect(planOf(run.id)).toMatchObject({
          name: "plan",
          status: "running",
          output: null,
          finishedAt: null,
          interruptedLogPaths: ["/logs/a.log", "/logs/b.log"],
        });
        expect(nextStep(db, run.id)).toEqual({
          step: "plan",
          interrupted: true,
        });
      });

      it("同じ場所を2回足しても、重複しない", () => {
        const run = startPlan();
        recordInterruptedLog(db, run.id, "plan", "/logs/a.log");
        recordInterruptedLog(db, run.id, "plan", "/logs/a.log");
        expect(planOf(run.id).interruptedLogPaths).toEqual(["/logs/a.log"]);
      });

      it("再開してステップが終わっても残り、log_path は再開した呼び出しを指す", () => {
        const run = startPlan();
        recordInterruptedLog(db, run.id, "plan", "/logs/a.log");
        // 事務局を起動し直した後。同じ行を使う。
        const resumed = startStep(db, clock, run.id, "plan");
        expect(resumed.interruptedLogPaths).toEqual(["/logs/a.log"]);
        finishStep(
          db,
          clock,
          {
            runId: run.id,
            step: "plan",
            outcome: "done",
            logPath: "/logs/b.log",
          },
          options,
        );
        expect(
          db
            .prepare(
              "SELECT status, log_path, interrupted_log_paths FROM steps WHERE name = 'plan'",
            )
            .get(),
        ).toEqual({
          status: "done",
          log_path: "/logs/b.log",
          interrupted_log_paths: '["/logs/a.log"]',
        });
      });

      it("実行中でないステップには、足せない", () => {
        const run = startRun(db, clock, target);
        record(run.id, "prepare");
        expect(() =>
          recordInterruptedLog(db, run.id, "prepare", "/logs/a.log"),
        ).toThrow("実行中ではありません");
        expect(() =>
          recordInterruptedLog(db, run.id, "plan", "/logs/a.log"),
        ).toThrow("実行中ではありません");
      });

      it("壊れた記録は、原因の分かるエラーにする", () => {
        const run = startPlan();
        db.prepare(
          "UPDATE steps SET interrupted_log_paths = '{}' WHERE name = 'plan'",
        ).run();
        expect(() => listSteps(db, run.id)).toThrow("steps の行が想定外");
      });
    });

    it("cleanup まで終わると、実行が完了になる", () => {
      const run = startRun(db, clock, target);
      for (const step of [
        "prepare",
        "plan",
        "implement",
        "verify",
        "review",
        "publish",
      ] as const) {
        expect(record(run.id, step).kind, step).toBe("run_step");
      }
      clock.set("2026-01-03T00:00:00.000Z");
      expect(record(run.id, "cleanup")).toEqual({
        kind: "finish",
        status: "done",
      });
      expect(getRun(db, run.id)).toMatchObject({
        status: "done",
        finishedAt: "2026-01-03T00:00:00.000Z",
        nextRetryAt: null,
      });
    });

    it("質問を返すと、実行が質問で終わる", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      expect(record(run.id, "plan", "question", { question: "?" })).toEqual({
        kind: "finish",
        status: "question",
      });
      expect(getRun(db, run.id)).toMatchObject({
        status: "question",
        nextRetryAt: null,
      });
    });

    it("publish が人間の対応待ちで止まると、実行が held で終わり、試行に数えず、待機も付かない", () => {
      const run = startRun(db, clock, target);
      for (const step of [
        "prepare",
        "plan",
        "implement",
        "verify",
        "review",
      ] as const) {
        record(run.id, step);
      }
      expect(
        record(run.id, "publish", "held", { status: "needs_approval" }),
      ).toEqual({ kind: "finish", status: "held" });
      expect(getRun(db, run.id)).toMatchObject({
        status: "held",
        nextRetryAt: null,
      });
      expect(listSteps(db, run.id).at(-1)).toMatchObject({
        name: "publish",
        status: "held",
      });
      expect(countFailedRuns(db, target.repo, target.issueNumber)).toBe(0);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(1);
      expect(retryNotBefore(db, target.repo, target.issueNumber)).toBeNull();
      expect(findResumableRuns(db)).toEqual([]);
    });

    describe("人間の承認", () => {
      const UNTIL_REVIEW = [
        "prepare",
        "plan",
        "implement",
        "verify",
        "review",
      ] as const;
      /** publish が人間の対応待ちで止まった実行を作る。 */
      const heldRun = () => {
        const run = startRun(db, clock, target);
        for (const step of UNTIL_REVIEW) record(run.id, step);
        record(run.id, "publish", "held", { status: "needs_approval" });
        return run;
      };
      const names = (runId: number) =>
        listSteps(db, runId).map((step) => `${step.name}:${step.status}`);

      it("止まったステップに、承認を1件だけ記録する。2回目は、最初の記録を返す", () => {
        const run = heldRun();
        const held = heldPublishStep(db, run.id);
        expect(held).toMatchObject({ count: 1, step: { name: "publish" } });

        const first = recordApproval(db, clock, {
          runId: run.id,
          headCommit: "abc",
        });
        expect(first).toMatchObject({
          runId: run.id,
          stepId: held?.step.id,
          headCommit: "abc",
          usedAt: null,
        });
        expect(first.createdAt).toMatch(ISO_UTC);
        // 承認したコミットは、やり直しても変わらない。
        expect(
          recordApproval(db, clock, { runId: run.id, headCommit: "other" }),
        ).toEqual(first);
        expect(findApproval(db, first.stepId)).toEqual(first);
        expect(approvedCommit(db, run.id)).toBeNull();
      });

      it("prepare で止まった実行は、止まったステップとして読める。承認の対象にはならない", () => {
        const run = startRun(db, clock, target);
        record(run.id, "prepare", "held", { status: "branch_exists" });
        expect(getRun(db, run.id).status).toBe("held");
        expect(heldStep(db, run.id)).toMatchObject({
          count: 1,
          step: { name: "prepare" },
        });
        expect(heldPublishStep(db, run.id)).toBeNull();
        // publish で止まった実行は、どちらからも読める。
        const published = heldRun();
        expect(heldStep(db, published.id)).toEqual(
          heldPublishStep(db, published.id),
        );
      });

      it("push した記録のあるコミットは、published で終わった publish のものだけ", () => {
        const run = startRun(db, clock, target);
        for (const step of UNTIL_REVIEW) record(run.id, step);
        record(run.id, "publish", "done", {
          status: "published",
          headCommit: "aaa",
        });
        const other = startRun(db, clock, { ...target, issueNumber: 8 });
        for (const step of UNTIL_REVIEW) record(other.id, step);
        record(other.id, "publish", "done", {
          status: "dry_run",
          headCommit: "bbb",
        });
        expect(publishedHeads(db, target.repo, 7)).toEqual(new Set(["aaa"]));
        expect(publishedHeads(db, target.repo, 8)).toEqual(new Set());
        expect(publishedHeads(db, "owner/other", 7)).toEqual(new Set());
      });

      it("止まっていない実行には、承認を記録できない", () => {
        const running = startRun(db, clock, target);
        record(running.id, "prepare");
        expect(() =>
          recordApproval(db, clock, { runId: running.id, headCommit: "abc" }),
        ).toThrow(/止まっていません/);
        expect(heldPublishStep(db, running.id)).toBeNull();
      });

      it("承認された実行を、publish からやり直せるようにする。2回行っても変わらない", () => {
        const run = heldRun();
        recordApproval(db, clock, { runId: run.id, headCommit: "abc" });

        const resumed = resumeApprovedRun(db, clock, run.id);
        expect(resumed).toMatchObject({
          status: "running",
          finishedAt: null,
          currentStep: "publish",
        });
        expect(names(run.id).slice(-2)).toEqual([
          "publish:held",
          "publish:running",
        ]);
        expect(approvedCommit(db, run.id)).toBe("abc");
        expect(nextStep(db, run.id).step).toBe("publish");
        expect(findResumableRuns(db).map((entry) => entry.step)).toEqual([
          "publish",
        ]);

        resumeApprovedRun(db, clock, run.id);
        expect(count("steps")).toBe(UNTIL_REVIEW.length + 2);

        // やり直した publish が通れば、cleanup に進む。
        expect(record(run.id, "publish")).toEqual({
          kind: "run_step",
          step: "cleanup",
        });
      });

      it("承認がなければ、再開できない。使用済みの承認でも、再開できない", () => {
        const run = heldRun();
        expect(() => resumeApprovedRun(db, clock, run.id)).toThrow(
          /未使用の承認がありません/,
        );

        recordApproval(db, clock, { runId: run.id, headCommit: "abc" });
        resumeApprovedRun(db, clock, run.id);
        // やり直した publish が、また止まった(コミットが変わっていた)。
        record(run.id, "publish", "held", { status: "needs_approval" });
        expect(heldPublishStep(db, run.id)?.count).toBe(2);
        expect(() => resumeApprovedRun(db, clock, run.id)).toThrow(
          /未使用の承認がありません/,
        );

        // 新しく止まったステップは、もう一度承認できる。
        recordApproval(db, clock, { runId: run.id, headCommit: "def" });
        resumeApprovedRun(db, clock, run.id);
        expect(approvedCommit(db, run.id)).toBe("def");
        expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(1);
      });
    });

    it("差し戻しは implement に戻り、3回目で実行が失敗になる", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      record(run.id, "plan");
      record(run.id, "implement");
      expect(record(run.id, "verify", "rework")).toEqual({
        kind: "run_step",
        step: "implement",
      });
      record(run.id, "implement");
      record(run.id, "verify");
      expect(record(run.id, "review", "rework")).toEqual({
        kind: "run_step",
        step: "implement",
      });
      record(run.id, "implement");
      expect(record(run.id, "verify", "rework")).toEqual({
        kind: "finish",
        status: "failed",
      });
      expect(getRun(db, run.id).status).toBe("failed");
    });

    it("日時はUTCのISO 8601形式で保存される", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare", "failed");
      const runRow = db
        .prepare("SELECT started_at, finished_at, next_retry_at FROM runs")
        .get() as Record<string, string>;
      const stepRow = db
        .prepare("SELECT started_at, finished_at FROM steps")
        .get() as Record<string, string>;
      for (const value of [
        ...Object.values(runRow),
        ...Object.values(stepRow),
      ]) {
        expect(value).toMatch(ISO_UTC);
      }
    });
  });

  describe("進み方に合わない記録", () => {
    it("次のステップでないものは始められない", () => {
      const run = startRun(db, clock, target);
      expect(() => startStep(db, clock, run.id, "plan")).toThrow(
        "次のステップは prepare です",
      );
      record(run.id, "prepare");
      expect(() => startStep(db, clock, run.id, "prepare")).toThrow(
        "次のステップは plan です",
      );
      expect(count("steps")).toBe(1);
    });

    it("始まっていないステップは終えられない", () => {
      const run = startRun(db, clock, target);
      expect(() =>
        finishStep(
          db,
          clock,
          { runId: run.id, step: "prepare", outcome: "done" },
          options,
        ),
      ).toThrow("始まっていません");
    });

    it("あり得ない結果は、記録せずにエラーにする", () => {
      const run = startRun(db, clock, target);
      startStep(db, clock, run.id, "prepare");
      expect(() =>
        finishStep(
          db,
          clock,
          { runId: run.id, step: "prepare", outcome: "rework" },
          options,
        ),
      ).toThrow("差し戻しを返せません");
      expect(listSteps(db, run.id)[0]?.status).toBe("running");
    });

    it("終わった実行では、ステップを始められない", () => {
      const run = failRun();
      expect(() => startStep(db, clock, run.id, "plan")).toThrow(
        "終わっています",
      );
    });

    it("存在しない実行はエラーにする", () => {
      expect(() => startStep(db, clock, 99, "prepare")).toThrow(
        "実行がありません: 99",
      );
    });
  });

  describe("2回行っても重複しない", () => {
    it("実行の開始", () => {
      const first = startRun(db, clock, target);
      clock.set("2026-01-02T04:00:00.000Z");
      const second = startRun(db, clock, target);
      expect(second).toEqual(first);
      expect(count("runs")).toBe(1);
    });

    it("別のイシュー、別のリポジトリの実行は別に作られる", () => {
      startRun(db, clock, target);
      startRun(db, clock, { repo: "owner/name", issueNumber: 8 });
      startRun(db, clock, { repo: "owner/other", issueNumber: 7 });
      expect(count("runs")).toBe(3);
    });

    it("ステップの開始", () => {
      const run = startRun(db, clock, target);
      const first = startStep(db, clock, run.id, "prepare");
      clock.set("2026-01-02T04:00:00.000Z");
      const second = startStep(db, clock, run.id, "prepare");
      expect(second).toEqual(first);
      expect(count("steps")).toBe(1);
    });

    it("ステップの終了", () => {
      const run = startRun(db, clock, target);
      const first = record(run.id, "prepare", "done", { path: "/work/a" });
      const before = db.prepare("SELECT * FROM steps").all();

      clock.set("2026-01-02T04:00:00.000Z");
      const second = finishStep(
        db,
        clock,
        {
          runId: run.id,
          step: "prepare",
          outcome: "done",
          output: { path: "/work/a" },
        },
        options,
      );
      expect(second).toEqual(first);
      expect(db.prepare("SELECT * FROM steps").all()).toEqual(before);
    });

    it("実行を終わらせるステップの終了", () => {
      const run = startRun(db, clock, target);
      const first = record(run.id, "prepare", "failed");
      const before = db.prepare("SELECT * FROM runs").all();

      clock.set("2026-01-02T04:00:00.000Z");
      const second = finishStep(
        db,
        clock,
        { runId: run.id, step: "prepare", outcome: "failed" },
        options,
      );
      expect(second).toEqual(first);
      expect(db.prepare("SELECT * FROM runs").all()).toEqual(before);
    });

    it("別の結果での終了は、黙って上書きせずにエラーにする", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare", "done", { path: "/work/a" });
      expect(() =>
        finishStep(
          db,
          clock,
          { runId: run.id, step: "prepare", outcome: "failed" },
          options,
        ),
      ).toThrow("別の結果(done)で終わっています");
    });

    it("DBの側でも、実行中の行の重複を拒む", () => {
      const run = startRun(db, clock, target);
      startStep(db, clock, run.id, "prepare");
      expect(() =>
        db
          .prepare(
            `INSERT INTO runs (repo, issue_number, attempt, status, started_at)
             VALUES ('owner/name', 7, 1, 'running', '2026-01-02T03:04:05.000Z')`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO steps (run_id, name, status, started_at)
             VALUES (?, 'plan', 'running', '2026-01-02T03:04:05.000Z')`,
          )
          .run(run.id),
      ).toThrow(/UNIQUE/);
    });
  });

  describe("再開", () => {
    it("終わっていない実行がなければ、空を返す", () => {
      failRun();
      expect(findResumableRuns(db)).toEqual([]);
    });

    it("まだどのステップも始めていない実行は、prepare から続ける", () => {
      const run = startRun(db, clock, target);
      expect(findResumableRuns(db)).toEqual([
        { run, step: "prepare", interrupted: false },
      ]);
    });

    it("途中まで記録された状態からは、最後に完了したステップの次が対象になる", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      record(run.id, "plan");
      record(run.id, "implement");

      const [resumable] = findResumableRuns(db);
      expect(resumable).toMatchObject({
        run: { id: run.id },
        step: "verify",
        interrupted: false,
      });
      // 返された対象を、そのまま続けられる。
      expect(startStep(db, clock, run.id, "verify").name).toBe("verify");
    });

    it("実行中のまま残ったステップは、やり直しの対象になる", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      record(run.id, "plan");
      startStep(db, clock, run.id, "implement");

      // 事務局が落ちて、起動し直したとする。
      expect(findResumableRuns(db)).toMatchObject([
        { run: { id: run.id }, step: "implement", interrupted: true },
      ]);

      // やり直しても行は増えず、終了まで記録できる。
      startStep(db, clock, run.id, "implement");
      expect(count("steps")).toBe(3);
      expect(
        finishStep(
          db,
          clock,
          { runId: run.id, step: "implement", outcome: "done" },
          options,
        ),
      ).toEqual({ kind: "run_step", step: "verify" });
    });

    it("差し戻しの直後は implement が対象になり、差し戻しの回数も引き継ぐ", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      record(run.id, "plan");
      record(run.id, "implement");
      record(run.id, "verify", "rework");
      record(run.id, "implement");
      record(run.id, "verify", "rework");

      expect(findResumableRuns(db)).toMatchObject([
        { step: "implement", interrupted: false },
      ]);

      // 再開した後の3回目の差し戻しは、上限に当たる。
      record(run.id, "implement");
      expect(record(run.id, "verify", "rework")).toEqual({
        kind: "finish",
        status: "failed",
      });
    });

    it("複数の実行を、それぞれの続きとともに返す", () => {
      const first = startRun(db, clock, target);
      record(first.id, "prepare");
      const second = startRun(db, clock, {
        repo: "owner/other",
        issueNumber: 1,
      });
      failRun(99);

      expect(findResumableRuns(db)).toMatchObject([
        { run: { id: first.id, repo: "owner/name" }, step: "plan" },
        { run: { id: second.id, repo: "owner/other" }, step: "prepare" },
      ]);
    });

    it("再開しても、何も書き換えない", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      startStep(db, clock, run.id, "plan");
      const dump = () => [
        db.prepare("SELECT * FROM runs").all(),
        db.prepare("SELECT * FROM steps").all(),
      ];
      const before = dump();
      findResumableRuns(db);
      findResumableRuns(db);
      expect(dump()).toEqual(before);
    });

    it("想定外の内容の行は、原因の分かるエラーにする", () => {
      const run = startRun(db, clock, target);
      db.prepare(
        `INSERT INTO steps (run_id, name, status, started_at)
         VALUES (?, 'unknown', 'done', '2026-01-02T03:04:05.000Z')`,
      ).run(run.id);
      expect(() => findResumableRuns(db)).toThrow(
        "steps の行が想定外の内容です",
      );
    });
  });

  describe("試行回数と待機時間", () => {
    it("失敗で終わった実行だけを、試行に数える", () => {
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(1);

      expect(failRun().attempt).toBe(1);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(2);

      // 質問を返して終了した実行は数えない。
      const asked = startRun(db, clock, target);
      expect(asked.attempt).toBe(2);
      record(asked.id, "prepare");
      record(asked.id, "plan", "question");
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(2);

      // 取り消された実行は数えない。
      const cancelled = startRun(db, clock, target);
      expect(cancelled.attempt).toBe(2);
      cancelRun(db, clock, cancelled.id);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(2);

      // 完了した実行は数えない。
      const done = startRun(db, clock, target);
      for (const step of [
        "prepare",
        "plan",
        "implement",
        "verify",
        "review",
        "publish",
        "cleanup",
      ] as const) {
        record(done.id, step);
      }
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(2);

      expect(failRun().attempt).toBe(2);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(3);
    });

    it("再開しても、試行回数は変わらない", () => {
      failRun();
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      startStep(db, clock, run.id, "plan");

      const [resumable] = findResumableRuns(db);
      expect(resumable?.run.attempt).toBe(2);
      expect(startRun(db, clock, target).attempt).toBe(2);
      startStep(db, clock, run.id, "plan");
      expect(getRun(db, run.id).attempt).toBe(2);
    });

    it("試行回数は、イシューごと、リポジトリごとに数える", () => {
      failRun();
      expect(nextAttempt(db, target.repo, 8)).toBe(1);
      expect(nextAttempt(db, "owner/other", target.issueNumber)).toBe(1);
    });

    it("リセットすると、次の実行は1回目になり、待機時間も最初の値に戻る", () => {
      failRun();
      failRun();
      const other = failRun(8);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(3);

      clock.set("2026-01-02T09:00:00.000Z");
      expect(resetAttempts(db, clock, target)).toBe(2);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(1);

      // 実行の記録は残り、リセットした時刻だけが入る。ほかのイシューには及ばない。
      expect(
        db
          .prepare(
            "SELECT issue_number, status, attempt, attempt_reset_at FROM runs ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          issue_number: 7,
          status: "failed",
          attempt: 1,
          attempt_reset_at: "2026-01-02T09:00:00.000Z",
        },
        {
          issue_number: 7,
          status: "failed",
          attempt: 2,
          attempt_reset_at: "2026-01-02T09:00:00.000Z",
        },
        {
          issue_number: 8,
          status: "failed",
          attempt: 1,
          attempt_reset_at: null,
        },
      ]);
      expect(nextAttempt(db, target.repo, other.issueNumber)).toBe(2);

      clock.set("2026-01-02T10:00:00.000Z");
      const retried = failRun();
      expect(retried.attempt).toBe(1);
      expect(retried.nextRetryAt).toBe("2026-01-02T10:05:00.000Z");
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(2);
    });

    it("2回リセットしても変わらない", () => {
      failRun();
      clock.set("2026-01-02T09:00:00.000Z");
      resetAttempts(db, clock, target);
      const before = db.prepare("SELECT * FROM runs").all();

      clock.set("2026-01-02T09:30:00.000Z");
      expect(resetAttempts(db, clock, target)).toBe(0);
      expect(db.prepare("SELECT * FROM runs").all()).toEqual(before);
    });

    it("時刻を渡すと、それまでに終わった失敗だけをリセットする", () => {
      const first = startRun(db, clock, target);
      record(first.id, "prepare", "failed");
      const firstFinishedAt = getRun(db, first.id).finishedAt as string;
      clock.set("2026-01-02T04:00:00.000Z");
      const second = startRun(db, clock, target);
      record(second.id, "prepare", "failed");

      expect(
        resetAttempts(db, clock, { ...target, finishedUntil: firstFinishedAt }),
      ).toBe(1);
      expect(countFailedRuns(db, target.repo, target.issueNumber)).toBe(1);
      expect(nextAttempt(db, target.repo, target.issueNumber)).toBe(2);
      // 何度行っても変わらない。
      expect(
        resetAttempts(db, clock, { ...target, finishedUntil: firstFinishedAt }),
      ).toBe(0);
    });

    it("次に再試行してよい時刻は、試行に数える最後の失敗のもの。リセットすると空になる", () => {
      expect(retryNotBefore(db, target.repo, target.issueNumber)).toBeNull();
      const run = startRun(db, clock, target);
      record(run.id, "prepare", "failed");
      expect(retryNotBefore(db, target.repo, target.issueNumber)).toBe(
        "2026-01-02T03:09:05.000Z",
      );
      resetAttempts(db, clock, target);
      expect(retryNotBefore(db, target.repo, target.issueNumber)).toBeNull();
    });

    it("失敗のたびに、設定の待機時間から次に再試行してよい時刻を決める", () => {
      clock.set("2026-01-02T10:00:00.000Z");
      expect(failRun().nextRetryAt).toBe("2026-01-02T10:05:00.000Z");
      clock.set("2026-01-02T11:00:00.000Z");
      expect(failRun().nextRetryAt).toBe("2026-01-02T11:30:00.000Z");
      clock.set("2026-01-02T12:00:00.000Z");
      expect(failRun().nextRetryAt).toBe("2026-01-02T14:00:00.000Z");
      // 回数が足りなければ、最後の値を使う。
      clock.set("2026-01-02T23:00:00.000Z");
      expect(failRun().nextRetryAt).toBe("2026-01-03T01:00:00.000Z");
    });

    it("待機時間は、渡された設定の値に従う", () => {
      const run = startRun(db, clock, target);
      startStep(db, clock, run.id, "prepare");
      clock.set("2026-01-02T10:00:00.000Z");
      finishStep(
        db,
        clock,
        { runId: run.id, step: "prepare", outcome: "failed" },
        { retryWaitMinutes: [1] },
      );
      expect(getRun(db, run.id).nextRetryAt).toBe("2026-01-02T10:01:00.000Z");
    });
  });

  describe("補助の読み書き", () => {
    it("ある時刻以降に開始した実行を、終わり方によらず、全リポジトリで数える", () => {
      const first = startRun(db, clock, target);
      cancelRun(db, clock, first.id);
      clock.set("2026-01-03T00:00:00.000Z");
      startRun(db, clock, target);
      startRun(db, clock, { repo: "owner/other", issueNumber: 1 });

      expect(countRunsStartedSince(db, "2026-01-02T00:00:00.000Z")).toBe(3);
      expect(countRunsStartedSince(db, "2026-01-03T00:00:00.000Z")).toBe(2);
      expect(countRunsStartedSince(db, "2026-01-03T00:00:00.001Z")).toBe(0);
    });

    it("UTCの1日に開始した実行を数える。日付の境目より前の実行は数えない", () => {
      clock.set("2026-01-02T23:59:59.999Z");
      const first = startRun(db, clock, target);
      cancelRun(db, clock, first.id);
      expect(countRunsStartedToday(db, clock.now())).toBe(1);

      clock.set("2026-01-03T00:00:00.000Z");
      expect(countRunsStartedToday(db, clock.now())).toBe(0);
      startRun(db, clock, target);
      clock.set("2026-01-03T12:00:00.000Z");
      startRun(db, clock, { repo: "owner/other", issueNumber: 1 });

      expect(countRunsStartedToday(db, clock.now())).toBe(2);
      expect(
        countRunsStartedToday(db, new Date("2026-01-03T23:59:59.999Z")),
      ).toBe(2);
      expect(
        countRunsStartedToday(db, new Date("2026-01-04T00:00:00.000Z")),
      ).toBe(0);
    });

    it("イシューの最新の実行を返す。なければ null", () => {
      expect(latestRun(db, target.repo, target.issueNumber)).toBeNull();
      const first = startRun(db, clock, target);
      cancelRun(db, clock, first.id);
      const second = startRun(db, clock, target);
      expect(latestRun(db, target.repo, target.issueNumber)?.id).toBe(
        second.id,
      );
    });

    it("次のステップを返す。終わった実行では失敗する", () => {
      const run = startRun(db, clock, target);
      expect(nextStep(db, run.id)).toEqual({
        step: "prepare",
        interrupted: false,
      });
      startStep(db, clock, run.id, "prepare");
      expect(nextStep(db, run.id)).toEqual({
        step: "prepare",
        interrupted: true,
      });
      cancelRun(db, clock, run.id);
      expect(() => nextStep(db, run.id)).toThrow(/終わっています/);
    });

    it("作業場所、ブランチ、PRの番号は、渡した項目だけを書く", () => {
      const run = startRun(db, clock, target);
      recordRunDetails(db, run.id, { workspacePath: "/w/1", branch: "b" });
      recordRunDetails(db, run.id, { prNumber: 5 });
      expect(
        db
          .prepare(
            "SELECT worktree_path, branch, pr_number FROM runs WHERE id = ?",
          )
          .get(run.id),
      ).toEqual({ worktree_path: "/w/1", branch: "b", pr_number: 5 });
    });
  });

  describe("取り消し", () => {
    it("実行と、実行中のステップが取り消しになる", () => {
      const run = startRun(db, clock, target);
      record(run.id, "prepare");
      startStep(db, clock, run.id, "plan");

      clock.set("2026-01-02T05:00:00.000Z");
      cancelRun(db, clock, run.id);

      expect(getRun(db, run.id)).toMatchObject({
        status: "cancelled",
        finishedAt: "2026-01-02T05:00:00.000Z",
        nextRetryAt: null,
      });
      expect(listSteps(db, run.id).map((step) => step.status)).toEqual([
        "done",
        "cancelled",
      ]);
      expect(findResumableRuns(db)).toEqual([]);
    });

    it("2回取り消しても変わらない", () => {
      const run = startRun(db, clock, target);
      cancelRun(db, clock, run.id);
      const before = getRun(db, run.id);
      clock.set("2026-01-02T05:00:00.000Z");
      cancelRun(db, clock, run.id);
      expect(getRun(db, run.id)).toEqual(before);
    });

    it("終わった実行は取り消せない", () => {
      const run = failRun();
      expect(() => cancelRun(db, clock, run.id)).toThrow("取り消せません");
    });
  });
});
