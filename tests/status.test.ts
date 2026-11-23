import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/office/clock.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import type { StepName, StepOutcome } from "../src/office/run-steps.ts";
import { finishStep, startRun, startStep } from "../src/office/runs.ts";
import {
  collectRunStatus,
  collectStatus,
  formatStatus,
  type RunStatus,
} from "../src/office/status.ts";

const clock = { now: () => new Date("2026-03-01T01:00:00.000Z") };

const NO_RUNS: RunStatus = {
  startedToday: 0,
  dailyRunLimit: 20,
  active: [],
  waitingClose: [],
  waitingRetry: [],
};

describe("状況表示", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, { clock });
    db.prepare("INSERT INTO repos (repo, last_polled_at) VALUES (?, ?)").run(
      "owner/name",
      "2026-03-01T00:59:00.000Z",
    );
    const issue = db.prepare(
      `INSERT INTO issues (repo, number, title, state, github_updated_at, synced_at)
       VALUES (?, ?, 't', ?, 'x', 'x')`,
    );
    issue.run("owner/name", 1, "triage");
    issue.run("owner/name", 2, "triage");
    issue.run("owner/name", 3, "closed");
    issue.run("owner/other", 1, "ready");
    const event = db.prepare(
      `INSERT INTO events (type, repo, issue_number, payload, created_at, handled_at)
       VALUES ('issue.created', ?, 1, '{}', 'x', ?)`,
    );
    event.run("owner/name", null);
    event.run("owner/name", null);
    event.run("owner/name", "2026-03-01T00:30:00.000Z");
    event.run("owner/other", null);
  });

  it("リポジトリごとに、状態別のイシュー数、未処理のイベント数、最終同期時刻を集める", () => {
    const [status] = collectStatus(db, ["owner/name"]);

    expect(status).toEqual({
      repo: "owner/name",
      issues: {
        triage: 2,
        "needs-info": 0,
        blocked: 0,
        ready: 0,
        "in-progress": 0,
        "in-review": 0,
        failed: 0,
        closed: 1,
      },
      unhandledEvents: 2,
      lastPolledAt: "2026-03-01T00:59:00.000Z",
    });
  });

  it("まだ同期していないリポジトリも表示する", () => {
    const statuses = collectStatus(db, ["owner/name", "owner/new"]);
    expect(statuses.map((s) => s.repo)).toEqual(["owner/name", "owner/new"]);
    expect(statuses[1]).toMatchObject({
      unhandledEvents: 0,
      lastPolledAt: null,
    });
  });

  it("読める形に整える", () => {
    const text = formatStatus(
      collectStatus(db, ["owner/name", "owner/new"]),
      NO_RUNS,
    );
    expect(text).toContain("owner/name");
    expect(text).toContain("最終同期: 2026-03-01T00:59:00.000Z");
    expect(text).toContain("未処理のイベント: 2");
    expect(text).toMatch(/triage\s+2/);
    expect(text).toContain("最終同期: 未同期");
  });
});

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

describe("実行の状況", () => {
  const retry = { retryWaitMinutes: [30, 120] };
  let db: Db;
  let time: FakeClock;

  beforeEach(() => {
    db = openDb(":memory:");
    time = new FakeClock("2026-02-28T22:00:00.000Z");
    migrate(db, { clock: time });
  });

  function addIssue(repo: string, number: number, state: string): void {
    db.prepare(
      `INSERT INTO issues (repo, number, title, state, github_updated_at, synced_at)
       VALUES (?, ?, 't', ?, 'x', 'x')`,
    ).run(repo, number, state);
  }

  /** 実行を始め、渡したステップを順に終える。 */
  function run(
    repo: string,
    issueNumber: number,
    steps: readonly (readonly [StepName, StepOutcome])[],
  ): number {
    const started = startRun(db, time, { repo, issueNumber });
    for (const [step, outcome] of steps) {
      startStep(db, time, started.id, step);
      finishStep(db, time, { runId: started.id, step, outcome }, retry);
    }
    return started.id;
  }

  const UNTIL_PUBLISH: readonly (readonly [StepName, StepOutcome])[] = [
    ["prepare", "done"],
    ["plan", "done"],
    ["implement", "done"],
    ["verify", "done"],
    ["review", "done"],
    ["publish", "done"],
  ];

  function collect(dailyRunLimit = 20): RunStatus {
    return collectRunStatus(db, { now: time.now(), dailyRunLimit });
  }

  it("実行が1つもないときは、空の集計を返し、出力もできる", () => {
    const status = collect();
    expect(status).toEqual(NO_RUNS);

    const text = formatStatus([], status);
    expect(text).toContain("リポジトリがありません。");
    expect(text).toContain("当日(UTC)に開始した実行: 0 / 20");
    expect(text).toContain("進行中の実行: なし");
    expect(text).toContain("クローズ待ちの実行: なし");
    expect(text).toContain("再試行を待っているイシュー: なし");
  });

  it("進行中の実行を、リポジトリ、イシュー番号、試行回数、現在のステップ、開始時刻とともに返す", () => {
    // 1回失敗した後の、2回目の実行。implement が動いている。
    run("owner/name", 12, [["prepare", "failed"]]);
    time.set("2026-03-01T00:40:00.000Z");
    const second = run("owner/name", 12, [
      ["prepare", "done"],
      ["plan", "done"],
    ]);
    startStep(db, time, second, "implement");
    // ステップの合間にある実行。次に行うステップを出す。
    time.set("2026-03-01T00:50:00.000Z");
    run("owner/other", 3, [["prepare", "done"]]);

    const status = collect();
    expect(status.active).toEqual([
      {
        repo: "owner/name",
        issueNumber: 12,
        attempt: 2,
        step: "implement",
        startedAt: "2026-03-01T00:40:00.000Z",
      },
      {
        repo: "owner/other",
        issueNumber: 3,
        attempt: 1,
        step: "plan",
        startedAt: "2026-03-01T00:50:00.000Z",
      },
    ]);
    expect(status.waitingClose).toEqual([]);

    const text = formatStatus([], status);
    expect(text).toContain("進行中の実行: 2");
    expect(text).toMatch(
      /owner\/name #12\s+試行2\s+implement\s+開始 2026-03-01T00:40:00\.000Z/,
    );
    expect(text).toMatch(
      /owner\/other #3\s+試行1\s+plan\s+開始 2026-03-01T00:50:00\.000Z/,
    );
  });

  it("クローズを待っているだけの実行は、進行中と分けて返す", () => {
    run("owner/name", 9, UNTIL_PUBLISH);
    time.set("2026-03-01T00:40:00.000Z");
    run("owner/name", 12, [["prepare", "done"]]);

    const status = collect();
    expect(status.active.map((r) => r.issueNumber)).toEqual([12]);
    expect(status.waitingClose).toEqual([
      {
        repo: "owner/name",
        issueNumber: 9,
        attempt: 1,
        startedAt: "2026-02-28T22:00:00.000Z",
      },
    ]);

    const text = formatStatus([], status);
    const active = text.indexOf("進行中の実行: 1");
    const waiting = text.indexOf("クローズ待ちの実行: 1");
    const line = text.indexOf("owner/name #9");
    expect(active).toBeGreaterThanOrEqual(0);
    expect(waiting).toBeGreaterThan(active);
    expect(line).toBeGreaterThan(waiting);
  });

  it("cleanup が動いている実行は、進行中として返す", () => {
    const id = run("owner/name", 9, UNTIL_PUBLISH);
    startStep(db, time, id, "cleanup");

    const status = collect();
    expect(status.active).toMatchObject([{ issueNumber: 9, step: "cleanup" }]);
    expect(status.waitingClose).toEqual([]);
  });

  it("当日(UTC)に開始した実行の数と上限を返す。前日の実行と、終わり方は問わない", () => {
    time.set("2026-02-28T23:59:59.999Z");
    run("owner/name", 1, [["prepare", "done"]]);
    time.set("2026-03-01T00:00:00.000Z");
    run("owner/name", 2, [["prepare", "failed"]]);
    run("owner/other", 1, []);
    time.set("2026-03-01T01:00:00.000Z");

    const status = collect(5);
    expect(status.startedToday).toBe(2);
    expect(status.dailyRunLimit).toBe(5);
    expect(formatStatus([], status)).toContain(
      "当日(UTC)に開始した実行: 2 / 5",
    );
  });

  it("失敗の後で待機中のイシューを、再試行してよい時刻とともに返す", () => {
    time.set("2026-03-01T00:50:00.000Z");
    // 待機中(30分後まで)。
    addIssue("owner/name", 7, "ready");
    run("owner/name", 7, [["prepare", "failed"]]);
    // 2回失敗している(120分後まで)。
    addIssue("owner/other", 2, "ready");
    run("owner/other", 2, [["prepare", "failed"]]);
    run("owner/other", 2, [["prepare", "failed"]]);
    // 失敗したが、ready に戻っていない。
    addIssue("owner/name", 8, "failed");
    run("owner/name", 8, [["prepare", "failed"]]);
    // 人間が戻して、試行がリセットされた。
    addIssue("owner/name", 10, "ready");
    run("owner/name", 10, [["prepare", "failed"]]);
    db.prepare(
      "UPDATE runs SET attempt_reset_at = 'x' WHERE issue_number = 10",
    ).run();
    // 失敗のない ready。
    addIssue("owner/name", 11, "ready");

    time.set("2026-03-01T01:00:00.000Z");
    const status = collect();
    expect(status.waitingRetry).toEqual([
      {
        repo: "owner/name",
        issueNumber: 7,
        retryAt: "2026-03-01T01:20:00.000Z",
      },
      {
        repo: "owner/other",
        issueNumber: 2,
        retryAt: "2026-03-01T02:50:00.000Z",
      },
    ]);
    const text = formatStatus([], status);
    expect(text).toContain("再試行を待っているイシュー: 2");
    expect(text).toMatch(
      /owner\/name #7\s+再試行は 2026-03-01T01:20:00\.000Z 以降/,
    );

    // 待機の時刻になったものは、待機中に出さない。
    time.set("2026-03-01T01:20:00.000Z");
    expect(collect().waitingRetry.map((w) => w.issueNumber)).toEqual([2]);
  });

  describe("読み取り専用のDB", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-test-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("読み取り専用で開いたDBで集計でき、DBの内容を変えない", () => {
      const file = path.join(dir, "factory.db");
      const writable = openDb(file);
      migrate(writable, { clock: time });
      db = writable;
      addIssue("owner/name", 7, "ready");
      run("owner/name", 7, [["prepare", "failed"]]);
      run("owner/name", 9, UNTIL_PUBLISH);
      run("owner/name", 12, [["prepare", "done"]]);
      const dump = (target: Db) =>
        ["repos", "issues", "events", "runs", "steps"].map((table) =>
          target.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
        );
      const before = dump(writable);
      writable.close();

      const readonly = new Database(file, { readonly: true });
      try {
        const status = collectRunStatus(readonly, {
          now: time.now(),
          dailyRunLimit: 20,
        });
        expect(status.active).toHaveLength(1);
        expect(status.waitingClose).toHaveLength(1);
        expect(status.waitingRetry).toHaveLength(1);
        expect(status.startedToday).toBe(3);
        expect(collectStatus(readonly, ["owner/name"])).toHaveLength(1);
        expect(dump(readonly)).toEqual(before);
      } finally {
        readonly.close();
      }
    });
  });
});
