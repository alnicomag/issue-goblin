/**
 * 担当者で、着手するファクトリーを分ける(設定の `assigned_only`)ときの、事務局の動き。
 * GitHub、ワーカー、起動係は偽の実装で、ネットワークには出ない。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findResumableRuns } from "../src/office/runs.ts";
import {
  heldComment,
  heldMarker,
  questionComment,
  questionMarker,
  type Supervisor,
} from "../src/office/supervisor.ts";
import { createHarness, type Harness, REPO } from "./factory-harness.ts";

const OWNER = "example-bot";
const OTHER = "someone-else";

/** 外から解くまで待たせる仕掛け。 */
function gate() {
  let open: () => void = () => {};
  let reached: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return {
    wait: async () => {
      reached();
      await opened;
    },
    entered,
    open,
  };
}

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

describe("実行の途中で担当から外れたとき", () => {
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
  const tickNoWait = async (target = supervisor) => {
    await h.sync();
    await target.tick([REPO]);
  };
  const runStatuses = () =>
    (
      h.db.prepare("SELECT status FROM runs ORDER BY id").all() as {
        status: string;
      }[]
    ).map((row) => row.status);
  const logged = (event: string) =>
    h.logs.filter((line) => line.event === event);
  const writesSince = (count: number) => h.fake.writes.slice(count);

  it("実行を取り消し、実行中のステップを止める。GitHubには書かない", async () => {
    const hold = gate();
    h.worker.scripts.set("implement", async () => {
      await hold.wait();
      return undefined;
    });
    h.putIssue(1, { assignees: [OWNER] });
    await tickNoWait();
    await hold.entered;
    const written = h.fake.writes.length;

    h.putIssue(1, { labels: ["state:in-progress"], assignees: [OTHER] });
    await tickNoWait();
    hold.open();
    await supervisor.idle();
    await tick();

    expect(runStatuses()).toEqual(["cancelled"]);
    expect(logged("run.cancelled").at(-1)?.fields).toMatchObject({
      issue: 1,
      reason: expect.stringContaining("担当者"),
    });
    expect(writesSince(written)).toEqual([]);
    expect(h.labels(1)).toEqual(["state:in-progress"]);
    expect(h.fake.pullRequests).toEqual([]);
    // 取り消した後は、ワーカーを呼ばない。
    expect(h.worker.callsOf("review")).toEqual([]);
  });

  it("事務局を途中で止めて起動し直しても、同じく取り消す", async () => {
    const hold = gate();
    h.worker.scripts.set("implement", async () => {
      await hold.wait();
      return undefined;
    });
    h.putIssue(1, { assignees: [OWNER] });
    await tickNoWait();
    await hold.entered;

    // 事務局を止める。実行は、実行中のまま残る。
    const stopping = supervisor.stop(1000);
    hold.open();
    expect(await stopping).toBe(true);
    expect(findResumableRuns(h.db)).toMatchObject([{ step: "implement" }]);
    const written = h.fake.writes.length;
    const implemented = h.worker.callsOf("implement").length;

    // 止まっている間に、担当から外れる。
    h.putIssue(1, { labels: ["state:in-progress"], assignees: [] });
    h.worker.scripts.delete("implement");
    supervisor = h.newSupervisor();
    await tick();
    await tick();

    expect(runStatuses()).toEqual(["cancelled"]);
    expect(h.worker.callsOf("implement")).toHaveLength(implemented);
    expect(writesSince(written)).toEqual([]);
  });

  it("PRを作ってクローズを待っている実行も、取り消す。修正依頼では、やり直さない", async () => {
    h.putIssue(1, { assignees: [OWNER] });
    await tick();
    await tick();
    expect(h.labels(1)).toEqual(["state:in-review"]);
    const written = h.fake.writes.length;
    const pr = h.fake.pullRequests[0]?.number ?? 0;

    h.putIssue(1, { labels: ["state:in-review"], assignees: [OTHER] });
    h.fake.putReview(pr, { id: 1, author: "example-login", body: "直して" });
    await tick();
    await tick();

    expect(runStatuses()).toEqual(["cancelled"]);
    expect(h.labels(1)).toEqual(["state:in-review"]);
    expect(writesSince(written)).toEqual([]);
    expect(h.worker.callsOf("implement")).toHaveLength(1);
  });

  it("質問で終わった実行の後処理の前に外れたら、コメントも状態の変更もしない", async () => {
    h.dryRun = true;
    h.putIssue(1, { labels: ["state:in-progress"], assignees: [OWNER] });
    await h.sync();
    // 質問で終わったが、コメントの前に止まった実行。
    h.db
      .prepare(
        `INSERT INTO runs (repo, issue_number, attempt, status, started_at, finished_at)
         VALUES (?, 1, 1, 'question', ?, ?)`,
      )
      .run(REPO, "2026-03-01T00:30:00.000Z", "2026-03-01T00:40:00.000Z");
    h.dryRun = false;
    supervisor = h.newSupervisor();

    h.putIssue(1, { labels: ["state:in-progress"], assignees: [OTHER] });
    await tick();

    expect(h.fake.writes).toEqual([]);
    expect(h.state(1)).toBe("in-progress");
  });

  it("dry_run の間も、取り消す(DBだけの操作)", async () => {
    h.putIssue(1, { labels: ["state:in-progress"], assignees: [OWNER] });
    await h.sync();
    h.db
      .prepare(
        `INSERT INTO runs (repo, issue_number, attempt, status, started_at)
         VALUES (?, 1, 1, 'running', ?)`,
      )
      .run(REPO, "2026-03-01T00:30:00.000Z");
    h.dryRun = true;
    supervisor = h.newSupervisor();

    h.putIssue(1, { labels: ["state:in-progress"], assignees: [OTHER] });
    await tick();

    expect(runStatuses()).toEqual(["cancelled"]);
    expect(h.fake.writes).toEqual([]);
  });

  it("無効(既定)なら、担当者が変わっても、実行を続ける", async () => {
    h.owner = null;
    h.putIssue(1, { assignees: [OWNER] });
    await tick();
    h.putIssue(1, { labels: h.labels(1).slice(), assignees: [OTHER] });
    await tick();
    expect(h.labels(1)).toEqual(["state:in-review"]);
    expect(runStatuses()).toEqual(["running"]);
  });
});

describe("イシューに残す目印", () => {
  it("担当者で分けないなら、いままでの形のまま", () => {
    expect(questionMarker(3)).toBe("<!-- factory:question run=3 -->");
    expect(heldMarker(3)).toBe("<!-- factory:held run=3 -->");
    expect(heldMarker(3, 2)).toBe("<!-- factory:held run=3 publish=2 -->");
  });

  it("担当者で分けるなら、持ち主のログイン名(小文字)を入れる", () => {
    expect(questionMarker(3, "Example-Bot")).toBe(
      "<!-- factory:question owner=example-bot run=3 -->",
    );
    expect(heldMarker(3, 1, "Example-Bot")).toBe(
      "<!-- factory:held owner=example-bot run=3 -->",
    );
    expect(heldMarker(3, 2, "Example-Bot")).toBe(
      "<!-- factory:held owner=example-bot run=3 publish=2 -->",
    );
    expect(questionComment(3, "質問", "example-bot")).toContain(
      "<!-- factory:question owner=example-bot run=3 -->",
    );
    expect(heldComment(3, null, 1, "example-bot")).toContain(
      "<!-- factory:held owner=example-bot run=3 -->",
    );
  });

  it("別の持ち主の目印とも、持ち主のない目印とも、一致しない", () => {
    const mine = questionMarker(1, "example-bot");
    for (const other of [
      questionMarker(1, "someone-else"),
      questionMarker(1),
      questionMarker(1, "example-bot-2"),
      questionMarker(11, "example-bot"),
    ]) {
      expect(other.includes(mine)).toBe(false);
      expect(mine.includes(other)).toBe(false);
    }
  });

  it("目印を崩すログイン名は、通さない", () => {
    expect(() => questionMarker(1, "a --> b")).toThrow(/ログイン名/);
  });

  describe("別のファクトリーの目印がイシューにあるとき", () => {
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

    const tick = async () => {
      await h.sync();
      await supervisor.tick([REPO]);
      await supervisor.idle();
    };
    const comments = () =>
      h.fake.comments
        .filter((comment) => comment.issueNumber === 1)
        .map((comment) => comment.body);

    it("同じ実行番号の、別の持ち主の質問があっても、自分の質問を書く。自分の質問は重ねない", async () => {
      // 前の担当のファクトリー(DBは別)が、同じ番号の実行で残した質問。
      h.fake.putComment({
        id: 1,
        issueNumber: 1,
        body: questionComment(1, "前の担当の質問", OTHER),
        updatedAt: "2026-03-01T00:10:00.000Z",
      });
      // 担当者で分ける前の形の目印。
      h.fake.putComment({
        id: 2,
        issueNumber: 1,
        body: questionComment(1, "古い形の質問"),
        updatedAt: "2026-03-01T00:11:00.000Z",
      });
      h.worker.answer("plan", { status: "question", summary: "自分の質問" });
      h.putIssue(1, { assignees: [OWNER] });

      await tick();
      await tick();
      await tick();

      expect(h.labels(1)).toEqual(["state:needs-info"]);
      const mine = comments().filter((body) =>
        body.includes(questionMarker(1, OWNER)),
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain("自分の質問");
    });

    it("同じ実行番号の、別の持ち主の対応待ちの知らせがあっても、自分の知らせを書く", async () => {
      h.fake.putComment({
        id: 1,
        issueNumber: 1,
        body: heldComment(1, null, 1, OTHER),
        updatedAt: "2026-03-01T00:10:00.000Z",
      });
      h.worker.scripts.set("implement", (call) => {
        h.worker.commitPath(call.repo, call.issue, "generated/out.txt");
        return { status: "done", summary: "実装" };
      });
      h.putIssue(1, { assignees: [OWNER] });

      await tick();
      await tick();

      expect(h.labels(1)).toEqual(["state:needs-info"]);
      expect(
        comments().filter((body) => body.includes(heldMarker(1, 1, OWNER))),
      ).toHaveLength(1);
    });
  });
});
