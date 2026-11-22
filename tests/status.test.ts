import { beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { collectStatus, formatStatus } from "../src/office/status.ts";

const clock = { now: () => new Date("2026-03-01T01:00:00.000Z") };

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
    const text = formatStatus(collectStatus(db, ["owner/name", "owner/new"]));
    expect(text).toContain("owner/name");
    expect(text).toContain("最終同期: 2026-03-01T00:59:00.000Z");
    expect(text).toContain("未処理のイベント: 2");
    expect(text).toMatch(/triage\s+2/);
    expect(text).toContain("最終同期: 未同期");
  });
});
