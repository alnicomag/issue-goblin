/**
 * 同じ製品を見る2つのファクトリーを、並べて動かす。
 *
 * GitHub(偽の実装)と取得元(手元のgitリポジトリ)は共有し、DB、ミラー、作業場所は別にする。
 * どちらも、担当者で着手を分ける(設定の `assigned_only`)。ネットワークには出ない。
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSteps } from "../src/office/runs.ts";
import {
  heldMarker,
  questionMarker,
  type Supervisor,
} from "../src/office/supervisor.ts";
import { branchFor, workspacePaths } from "../src/office/workspace.ts";
import { createHarness, type Harness, REPO } from "./factory-harness.ts";
import { plainGit } from "./git-fixtures.ts";

const ALICE = "alice-bot";
const BOB = "bob-bot";

interface Factory {
  readonly h: Harness;
  supervisor: Supervisor;
}

describe("同じ製品を見る2つのファクトリー", () => {
  let alice: Factory;
  let bob: Factory;

  const start = (options: { dryRun?: boolean } = {}) => {
    const first = createHarness({ owner: ALICE, ...options });
    const second = createHarness({
      owner: BOB,
      ...options,
      shared: { fake: first.fake, source: first.source },
    });
    alice = { h: first, supervisor: first.newSupervisor() };
    bob = { h: second, supervisor: second.newSupervisor() };
  };

  beforeEach(() => start());

  afterEach(async () => {
    for (const factory of [bob, alice]) {
      await factory.supervisor.stop(1000);
      factory.h.cleanup();
    }
  });

  const tick = async (factory: Factory) => {
    await factory.h.sync();
    await factory.supervisor.tick([REPO]);
    await factory.supervisor.idle();
  };
  /** 2つのファクトリーを、交互に `rounds` 回ずつ動かす。 */
  const tickBoth = async (rounds = 3) => {
    for (let i = 0; i < rounds; i += 1) {
      await tick(alice);
      await tick(bob);
    }
  };
  const runsOf = (factory: Factory) =>
    factory.h.db
      .prepare("SELECT id, issue_number, status FROM runs ORDER BY id")
      .all() as { id: number; issue_number: number; status: string }[];
  /** そのファクトリーが、GitHubに書き込んだ記録(ログ)。 */
  const writesOf = (factory: Factory) =>
    factory.h.logs
      .filter((line) => line.event === "github.write")
      .map((line) => line.fields);
  const workspaces = (factory: Factory) =>
    [1, 2, 3].filter((issue) =>
      fs.existsSync(workspacePaths(factory.h.dirs, REPO, issue).issueDir),
    );
  /** 取得元(GitHubの代わり)にある、ブランチの先頭。なければ null。 */
  const remoteTip = (issue: number): string | null => {
    const output = plainGit(
      alice.h.source,
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/${branchFor(issue)}`,
    );
    return output === "" ? null : output;
  };
  const commentsOn = (issue: number) =>
    alice.h.fake.comments
      .filter((comment) => comment.issueNumber === issue)
      .map((comment) => comment.body);
  const prOf = (issue: number) =>
    alice.h.fake.pullRequests.filter(
      (pr) => pr.open && pr.head === branchFor(issue),
    );

  it("それぞれが、自分の担当のイシューだけに着手し、相手の担当のイシューには書き込まない", async () => {
    alice.h.putIssue(1, { assignees: [ALICE] });
    alice.h.putIssue(2, { assignees: [BOB] });
    alice.h.putIssue(3);

    await tickBoth();

    expect(runsOf(alice).map((run) => run.issue_number)).toEqual([1]);
    expect(runsOf(bob).map((run) => run.issue_number)).toEqual([2]);
    expect(alice.h.labels(1)).toEqual(["state:in-review"]);
    expect(alice.h.labels(2)).toEqual(["state:in-review"]);
    // 誰の担当でもないイシューには、どちらも着手しない。
    expect(alice.h.labels(3)).toEqual(["state:ready"]);

    // 状態、ラベル、コメント、PRへの書き込みは、自分の担当のイシューの分だけ。
    // 書き込みのログは、イシューの番号か、ブランチ(push とPRの作成)で、対象が分かる。
    const touched = (fields: Record<string, unknown>) =>
      fields.issue ?? fields.branch ?? fields.head;
    expect(new Set(writesOf(alice).map(touched))).toEqual(
      new Set([1, branchFor(1)]),
    );
    expect(new Set(writesOf(bob).map(touched))).toEqual(
      new Set([2, branchFor(2)]),
    );
    expect(prOf(1)).toHaveLength(1);
    expect(prOf(2)).toHaveLength(1);
    expect(commentsOn(1)).toEqual([]);
    expect(commentsOn(2)).toEqual([]);

    // ブランチと作業場所も、自分の担当の分だけ。
    expect(workspaces(alice)).toEqual([1]);
    expect(workspaces(bob)).toEqual([2]);
    expect(remoteTip(1)).not.toBeNull();
    expect(remoteTip(2)).not.toBeNull();
    expect(remoteTip(3)).toBeNull();
    expect(alice.h.worker.calls.every((call) => call.issue === 1)).toBe(true);
    expect(bob.h.worker.calls.every((call) => call.issue === 2)).toBe(true);
  });

  it("相手の担当のイシューで起きた質問や状態の変更にも、反応しない", async () => {
    bob.h.worker.answer("plan", { status: "question", summary: "bobの質問" });
    alice.h.putIssue(1, { assignees: [ALICE] });
    alice.h.putIssue(2, { assignees: [BOB] });

    await tickBoth();

    expect(alice.h.labels(2)).toEqual(["state:needs-info"]);
    expect(
      commentsOn(2).filter((body) => body.includes(questionMarker(1, BOB))),
    ).toHaveLength(1);
    expect(commentsOn(2)).toHaveLength(1);
    expect(writesOf(alice).every((fields) => fields.issue !== 2)).toBe(true);
    expect(runsOf(alice).map((run) => run.issue_number)).toEqual([1]);
  });

  it("dry_run の間は、どちらも、GitHubに1回も書き込まない", async () => {
    await Promise.all(
      [bob, alice].map((factory) => factory.supervisor.stop(1000)),
    );
    for (const factory of [bob, alice]) factory.h.cleanup();
    start({ dryRun: true });
    alice.h.putIssue(1, { assignees: [ALICE] });
    alice.h.putIssue(2, { assignees: [BOB] });
    // ラベルのないイシュー(triage のラベル付けの対象)。
    alice.h.putIssue(3, { labels: [], assignees: [ALICE] });

    await tickBoth();

    expect(alice.h.fake.writes).toEqual([]);
    expect(remoteTip(1)).toBeNull();
    expect(remoteTip(2)).toBeNull();
    expect(runsOf(alice)).toEqual([]);
    expect(runsOf(bob)).toEqual([]);
    // 着手するはずだったイシューは、自分の担当の分だけを、ログに出す。
    const held = (factory: Factory) =>
      factory.h.logs
        .filter((line) => line.event === "intake.held")
        .map((line) => line.fields.issue);
    expect(held(alice)).toEqual([1]);
    expect(held(bob)).toEqual([2]);
  });

  describe("担当が移ったイシュー", () => {
    /** alice がPRまで進めたイシュー1を、人間が bob に移して、`ready` に戻す。 */
    const handOver = async () => {
      alice.h.putIssue(1, { assignees: [ALICE] });
      await tick(alice);
      await tick(alice);
      expect(alice.h.labels(1)).toEqual(["state:in-review"]);
      alice.h.putIssue(1, { labels: ["state:ready"], assignees: [BOB] });
    };

    it("前の担当の実行は取り消され、新しい担当は、残ったブランチを上書きせずに、人間の対応待ちにする", async () => {
      await handOver();
      const aliceTip = remoteTip(1);
      const alicePr = prOf(1)[0];
      const aliceWrites = writesOf(alice).length;

      await tickBoth();

      // 前の担当: 取り消すだけで、書き込まない。
      expect(runsOf(alice).map((run) => run.status)).toEqual(["cancelled"]);
      expect(writesOf(alice)).toHaveLength(aliceWrites);

      // 新しい担当: prepare で止まり、理由をコメントして、needs-info に進める。
      expect(runsOf(bob).map((run) => run.status)).toEqual(["held"]);
      expect(
        listSteps(bob.h.db, 1).map((step) => `${step.name}:${step.status}`),
      ).toEqual(["prepare:held"]);
      expect(alice.h.labels(1)).toEqual(["state:needs-info"]);
      const notices = commentsOn(1).filter((body) =>
        body.includes(heldMarker(1, 1, BOB)),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("branch_exists");
      expect(notices[0]).toContain(branchFor(1));
      expect(notices[0]).toContain(aliceTip);

      // 前のブランチとPRは、そのまま。Claudeは呼ばず、作業場所も作らない。
      expect(remoteTip(1)).toBe(aliceTip);
      expect(prOf(1)).toEqual([alicePr]);
      expect(bob.h.worker.calls).toEqual([]);
      expect(workspaces(bob)).toEqual([]);

      // 何度ポーリングしても、知らせは重ならず、再試行もしない。
      await tickBoth();
      expect(commentsOn(1)).toHaveLength(1);
      expect(runsOf(bob)).toHaveLength(1);
    });

    it("人間がブランチを消して ready に戻すと、新しい担当が、最初から着手する", async () => {
      await handOver();
      await tickBoth();
      expect(alice.h.labels(1)).toEqual(["state:needs-info"]);

      // 人間の対応: 前のPRを閉じ、ブランチを消して、ready に戻す。
      for (const pr of alice.h.fake.pullRequests) pr.open = false;
      plainGit(alice.h.source, "branch", "--quiet", "-D", branchFor(1));
      alice.h.putIssue(1, { labels: ["state:ready"], assignees: [BOB] });

      await tickBoth();

      expect(alice.h.labels(1)).toEqual(["state:in-review"]);
      expect(runsOf(bob).map((run) => run.status)).toEqual(["held", "running"]);
      expect(prOf(1)).toHaveLength(1);
      expect(remoteTip(1)).not.toBeNull();
      expect(runsOf(alice).map((run) => run.status)).toEqual(["cancelled"]);
    });

    it("prepare の後でブランチが現れても、publish が、上書きせずに止める", async () => {
      alice.h.putIssue(2, { assignees: [BOB] });
      // 実装の間に、別のファクトリーが、同じ名前のブランチを push した、という想定。
      bob.h.worker.scripts.set("implement", (call) => {
        plainGit(alice.h.source, "branch", "--quiet", branchFor(2), "main");
        bob.h.worker.commit(call.repo, call.issue);
        return { status: "done", summary: "実装" };
      });
      const foreign = plainGit(alice.h.source, "rev-parse", "main");

      await tickBoth();

      expect(runsOf(bob).map((run) => run.status)).toEqual(["held"]);
      expect(listSteps(bob.h.db, 1).at(-1)).toMatchObject({
        name: "publish",
        status: "held",
      });
      expect(remoteTip(2)).toBe(foreign);
      expect(alice.h.fake.pullRequests).toEqual([]);
      expect(alice.h.labels(2)).toEqual(["state:needs-info"]);
      expect(commentsOn(2)[0]).toContain("branch_exists");
    });
  });

  it("自分が push したブランチは、修正依頼のやり直しで、いままでどおり上書きできる", async () => {
    alice.h.putIssue(1, { assignees: [ALICE] });
    await tick(alice);
    await tick(alice);
    const first = remoteTip(1);
    const pr = prOf(1)[0]?.number ?? 0;

    alice.h.fake.putReview(pr, {
      id: 1,
      author: "example-login",
      body: "直して",
    });
    for (let i = 0; i < 3; i += 1) await tick(alice);

    expect(alice.h.labels(1)).toEqual(["state:in-review"]);
    expect(remoteTip(1)).not.toBe(first);
    expect(runsOf(alice).map((run) => run.status)).toEqual(["running"]);
  });
});

describe("担当者で分けないファクトリー(既定)", () => {
  it("リモートに同じ名前のブランチがあっても、いままでどおり上書きする", async () => {
    const h = createHarness();
    const supervisor = h.newSupervisor();
    try {
      plainGit(h.source, "branch", "--quiet", branchFor(1), "main");
      const before = plainGit(h.source, "rev-parse", branchFor(1));
      h.putIssue(1, { assignees: ["someone-else"] });
      for (let i = 0; i < 2; i += 1) {
        await h.sync();
        await supervisor.tick([REPO]);
        await supervisor.idle();
      }
      expect(h.labels(1)).toEqual(["state:in-review"]);
      expect(plainGit(h.source, "rev-parse", branchFor(1))).not.toBe(before);
    } finally {
      await supervisor.stop(1000);
      h.cleanup();
    }
  });
});
