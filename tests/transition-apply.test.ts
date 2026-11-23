import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/office/clock.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { createRepoLocks } from "../src/office/locks.ts";
import type { LogFields, Logger } from "../src/office/log.ts";
import { nextAttempt } from "../src/office/runs.ts";
import { syncAll } from "../src/office/sync.ts";
import { applyTransition } from "../src/office/transition-apply.ts";
import {
  ISSUE_STATES,
  isTransitionAllowed,
} from "../src/office/transitions.ts";
import { FakeGitHub } from "./fake-github.ts";

const REPO = "owner/name";
const T1 = "2026-03-01T00:00:01.000Z";
const NOW = "2026-03-01T01:00:00.000Z";

describe("事務局による状態の変更", () => {
  let db: Db;
  let clock: Clock;
  let logs: { level: string; event: string; fields: LogFields }[];
  let logger: Logger;
  let fake: FakeGitHub;
  const locks = createRepoLocks();

  beforeEach(() => {
    db = openDb(":memory:");
    clock = { now: () => new Date(NOW) };
    migrate(db, { clock });
    logs = [];
    const push =
      (level: string) =>
      (event: string, fields: LogFields = {}) =>
        void logs.push({ level, event, fields });
    logger = { info: push("info"), warn: push("warn"), error: push("error") };
    fake = new FakeGitHub();
  });

  const sync = () =>
    syncAll({ db, apiFor: () => fake, dryRun: true, clock, logger, locks }, [
      REPO,
    ]);

  const seed = async (state: string, number = 1) => {
    // 取得位置より後の時刻にする(書き込みのたびに、偽のGitHubの更新時刻が進むため)。
    const updatedAt = new Date(Date.parse(T1) + number * 60_000).toISOString();
    fake.putIssue({ number, labels: [`state:${state}`], updatedAt });
    await sync();
  };

  const apply = (
    to: (typeof ISSUE_STATES)[number],
    options: { dryRun?: boolean; issue?: number } = {},
  ) =>
    applyTransition(
      {
        db,
        write: { api: fake, dryRun: options.dryRun ?? false, logger },
        clock,
        locks,
      },
      { repo: REPO, issue: options.issue ?? 1, to, reason: "test" },
    );

  const dbState = (number = 1) =>
    (
      db
        .prepare("SELECT state FROM issues WHERE repo = ? AND number = ?")
        .get(REPO, number) as { state: string }
    ).state;

  const rejections = () =>
    db
      .prepare(
        "SELECT payload FROM events WHERE type = 'issue.transition_rejected' ORDER BY id",
      )
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload));

  it("遷移表にある変更は、ラベルを付け替えて、DBの状態も更新する", async () => {
    await seed("ready");
    expect(await apply("in-progress")).toEqual({
      status: "applied",
      from: "ready",
    });
    expect(fake.issues[0]?.labels).toEqual(["state:in-progress"]);
    expect(dbState()).toBe("in-progress");
    expect(rejections()).toEqual([]);
  });

  it("遷移表にない変更は、書き込まずに、イベントとログに残す", async () => {
    await seed("ready");
    const result = await apply("in-review");
    expect(result).toMatchObject({ status: "rejected", from: "ready" });
    expect(fake.writes).toEqual([]);
    expect(dbState()).toBe("ready");
    expect(rejections()).toEqual([
      { from: "ready", to: "in-review", actor: "office", reason: "test" },
    ]);
    expect(
      logs.filter((line) => line.event === "transition.rejected"),
    ).toHaveLength(1);
  });

  it("事務局が実行できるのは、遷移表で事務局のものとされた変更だけ", async () => {
    let number = 0;
    for (const from of ISSUE_STATES) {
      if (from === "closed") continue;
      for (const to of ISSUE_STATES) {
        if (to === from || to === "closed") continue;
        number += 1;
        await seed(from, number);
        const before = fake.writes.length;
        const result = await apply(to, { issue: number });
        const allowed = isTransitionAllowed(from, to, "office");
        expect(result.status, `${from} → ${to}`).toBe(
          allowed ? "applied" : "rejected",
        );
        expect(fake.writes.length > before, `${from} → ${to}`).toBe(allowed);
        expect(dbState(number), `${from} → ${to}`).toBe(allowed ? to : from);
      }
    }
    // 司令塔の遷移(triage → ready など)は、事務局には実行できない。
    expect(isTransitionAllowed("triage", "ready", "office")).toBe(false);
  });

  it("クローズ済みのイシューの状態は変えない", async () => {
    fake.putIssue({ number: 1, open: false, updatedAt: T1 });
    await sync();
    expect((await apply("in-review")).status).toBe("rejected");
    expect(fake.writes).toEqual([]);
  });

  it("同じ却下を繰り返しても、イベントは1件のまま", async () => {
    await seed("ready");
    await apply("in-review");
    await apply("in-review");
    expect(rejections()).toHaveLength(1);
  });

  it("すでにその状態なら、何も書かない", async () => {
    await seed("in-progress");
    expect(await apply("in-progress")).toEqual({ status: "unchanged" });
    expect(fake.writes).toEqual([]);
  });

  it("dry_run が true なら、書き込まず、DBの状態も変えない", async () => {
    await seed("ready");
    expect(await apply("in-progress", { dryRun: true })).toEqual({
      status: "dry_run",
      from: "ready",
    });
    expect(fake.writes).toEqual([]);
    expect(dbState()).toBe("ready");
  });

  it("書き込みに失敗したら、DBの状態を変えない。やり直せる", async () => {
    await seed("ready");
    fake.failWritesWith = new Error("boom");
    await expect(apply("in-progress")).rejects.toThrow("boom");
    expect(dbState()).toBe("ready");
    fake.failWritesWith = null;
    expect((await apply("in-progress")).status).toBe("applied");
  });

  it("事務局が変えた状態は、次の同期で人間の変更として記録されない", async () => {
    await seed("ready");
    await apply("in-progress");
    await sync();
    await sync();
    const changed = db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'issue.state_changed'",
      )
      .get() as { n: number };
    expect(changed.n).toBe(0);
    expect(dbState()).toBe("in-progress");
  });

  it("failed を離れたら、試行回数をリセットする", async () => {
    await seed("failed");
    db.prepare(
      `INSERT INTO runs (repo, issue_number, attempt, status, started_at, finished_at)
       VALUES (?, 1, 1, 'failed', ?, ?)`,
    ).run(REPO, NOW, NOW);
    expect(nextAttempt(db, REPO, 1)).toBe(2);
    expect((await apply("triage")).status).toBe("applied");
    expect(nextAttempt(db, REPO, 1)).toBe(1);
  });

  it("イシューがDBになければ失敗する", async () => {
    await expect(apply("in-progress")).rejects.toThrow(/イシューがありません/);
  });
});

describe("リポジトリごとの排他", () => {
  it("同じリポジトリの処理は、順に1つずつ進む。失敗しても次は進む", async () => {
    const locks = createRepoLocks();
    const order: string[] = [];
    const task =
      (name: string, fail = false) =>
      async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:end`);
        if (fail) throw new Error(name);
        return name;
      };
    const results = await Promise.allSettled([
      locks.run(REPO, task("a", true)),
      locks.run(REPO, task("b")),
      locks.run("owner/other", task("c")),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(order.filter((entry) => !entry.startsWith("c"))).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
    ]);
    // 別のリポジトリは待たない。
    expect(order.indexOf("c:start")).toBeLessThan(order.indexOf("a:end"));
  });
});
