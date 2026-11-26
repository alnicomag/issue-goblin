/**
 * 担当者で、着手するファクトリーを分ける(設定の `assigned_only`)ときの、事務局の動き。
 * GitHub、ワーカー、起動係は偽の実装で、ネットワークには出ない。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Supervisor } from "../src/office/supervisor.ts";
import { createHarness, type Harness, REPO } from "./factory-harness.ts";

const OWNER = "example-bot";
const OTHER = "someone-else";

describe("担当者で分けるときの着手", () => {
  let h: Harness;
  let supervisor: Supervisor;

  beforeEach(() => {
    h = createHarness({ owner: OWNER });
    supervisor = h.newSupervisor();
  });

  afterEach(async () => {
    await supervisor.stop(1000);
    h.cleanup();
  });

  const tick = async (target = supervisor) => {
    await h.sync();
    await target.tick([REPO]);
    await target.idle();
  };
  const runIssues = () =>
    (
      h.db.prepare("SELECT issue_number FROM runs ORDER BY id").all() as {
        issue_number: number;
      }[]
    ).map((row) => row.issue_number);
  const logged = (event: string) =>
    h.logs.filter((line) => line.event === event);

  it("担当者に持ち主がいる ready のイシューだけに着手する。見送った理由がログに出る", async () => {
    h.putIssue(1, { assignees: [OTHER] });
    h.putIssue(2, { assignees: ["Example-Bot"] });
    h.putIssue(3);

    await tick();

    expect(runIssues()).toEqual([2]);
    expect(h.labels(1)).toEqual(["state:ready"]);
    expect(h.labels(3)).toEqual(["state:ready"]);
    expect(logged("intake.skipped").at(-1)?.fields.reasons).toEqual({
      not_assigned: 2,
    });
    // 担当外のイシューには、何も書いていない。
    expect(
      h.fake.writes.filter(
        (call) => "issueNumber" in call && call.issueNumber !== 2,
      ),
    ).toEqual([]);
  });

  it("後から担当になったイシューには、着手する", async () => {
    h.putIssue(1, { assignees: [OTHER] });
    await tick();
    expect(runIssues()).toEqual([]);

    h.putIssue(1, { assignees: [OTHER, OWNER] });
    await tick();
    expect(runIssues()).toEqual([1]);
  });

  it("無効(既定)なら、担当者によらず、いままでと同じ条件で着手する", async () => {
    h.owner = null;
    h.putIssue(1, { assignees: [OTHER] });
    h.putIssue(2);
    for (let i = 0; i < 3; i += 1) await tick();
    expect(runIssues()).toEqual([1, 2]);
  });

  it("dry_run の間は、担当外のイシューを、見送った着手として出さない", async () => {
    h.dryRun = true;
    supervisor = h.newSupervisor();
    h.putIssue(1, { assignees: [OTHER] });
    h.putIssue(2, { assignees: [OWNER] });

    await tick();

    expect(logged("intake.held").map((line) => line.fields.issue)).toEqual([2]);
    expect(h.fake.writes).toEqual([]);
  });
});
