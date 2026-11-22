import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/office/clock.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import type { StepName, StepOutcome } from "../src/office/run-steps.ts";
import {
  cancelRun,
  findResumableRuns,
  finishStep,
  getRun,
  listSteps,
  nextAttempt,
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
