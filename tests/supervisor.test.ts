import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_MARKER } from "../src/office/github.ts";
import {
  findResumableRuns,
  listSteps,
  nextAttempt,
  recordApproval,
  startRun,
} from "../src/office/runs.ts";
import {
  heldComment,
  heldMarker,
  questionComment,
  questionMarker,
  type Supervisor,
} from "../src/office/supervisor.ts";
import { workspacePaths } from "../src/office/workspace.ts";
import { createHarness, type Harness, REPO } from "./factory-harness.ts";
import { VALID_FACTORY_YML } from "./fake-github.ts";
import { plainGit, unconfiguredGit } from "./git-fixtures.ts";

interface RunRow {
  id: number;
  issue_number: number;
  attempt: number;
  status: string;
  attempt_reset_at: string | null;
}

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
    /** ここで、解かれるまで待つ。 */
    wait: async () => {
      reached();
      await opened;
    },
    /** 待ちに入るまで待つ。 */
    entered,
    open,
  };
}

describe("実行の管理", () => {
  let h: Harness;
  let supervisor: Supervisor;

  beforeEach(() => {
    h = createHarness();
    supervisor = h.newSupervisor();
  });

  afterEach(async () => {
    await supervisor.stop(1000);
    h.cleanup();
  });

  /** 同期して、行うべきことを行い、進めた実行が一区切りつくまで待つ。 */
  const tick = async (target = supervisor) => {
    await h.sync();
    await target.tick([REPO]);
    await target.idle();
  };
  /** 同期して、行うべきことを行う。実行は待たない。 */
  const tickNoWait = async (target = supervisor) => {
    await h.sync();
    await target.tick([REPO]);
  };
  const runs = () =>
    h.db
      .prepare(
        "SELECT id, issue_number, attempt, status, attempt_reset_at FROM runs ORDER BY id",
      )
      .all() as RunRow[];
  const writes = () => h.fake.writes.map((call) => call.method);
  const labelWrites = () =>
    h.fake.writes.flatMap((call) =>
      call.method === "addLabels"
        ? call.labels.map((label) => `+${label}`)
        : call.method === "removeLabel"
          ? [`-${call.label}`]
          : call.method === "createPullRequest"
            ? ["PR"]
            : call.method === "createIssueComment"
              ? ["comment"]
              : [],
    );
  const factoryComments = (issue: number) =>
    h.fake.comments.filter(
      (comment) =>
        comment.issueNumber === issue && comment.body.includes(FACTORY_MARKER),
    );
  const setFactoryYml = (replace: [string, string]) => {
    h.fake.file = {
      sha: `sha-${replace[1]}`,
      content: VALID_FACTORY_YML.replace(...replace),
    };
  };
  const logged = (event: string) =>
    h.logs.filter((line) => line.event === event);
  const fail = { status: "failed", summary: "できませんでした" } as const;
  /** 待機時間を過ぎたことにする。 */
  const wait = (minutes: number) => {
    h.clock.time = new Date(
      Date.parse(h.clock.time) + minutes * 60_000,
    ).toISOString();
  };

  describe("着手からPRまで", () => {
    it("ready のイシューが、in-progress を経て、PRの作成後に in-review になる", async () => {
      h.putIssue(1);
      await tick();
      expect(h.labels(1)).toEqual(["state:in-progress"]);
      expect(h.state(1)).toBe("in-progress");
      expect(h.fake.pullRequests).toHaveLength(1);

      await tick();
      expect(h.labels(1)).toEqual(["state:in-review"]);
      expect(h.state(1)).toBe("in-review");
      expect(labelWrites()).toEqual([
        "+state:in-progress",
        "-state:ready",
        "PR",
        "+state:in-review",
        "-state:in-progress",
      ]);
      expect(runs()).toMatchObject([
        { issue_number: 1, attempt: 1, status: "running" },
      ]);
    });

    it("in-review になった後は、何度回しても何も書かない", async () => {
      h.putIssue(1);
      await tick();
      await tick();
      const before = writes();
      await tick();
      await tick();
      expect(writes()).toEqual(before);
      expect(runs()).toHaveLength(1);
      // 事務局自身の変更は、人間の変更として記録されない。
      expect(
        h.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE type = 'issue.state_changed'",
          )
          .get(),
      ).toEqual({ n: 0 });
    });

    it("イシューがクローズされたら、作業場所を片付けて、実行を終える", async () => {
      h.putIssue(1);
      await tick();
      await tick();
      h.putIssue(1, { labels: ["state:in-review"], open: false });
      await tick();
      expect(runs()).toMatchObject([{ status: "done" }]);
      expect(listSteps(h.db, 1).at(-1)).toMatchObject({
        name: "cleanup",
        status: "done",
      });
    });

    it("遷移表にない変更は、実行されずに記録される", async () => {
      // publish まで終わった実行があるのに、イシューが triage に戻されている場合。
      h.putIssue(1);
      await tick();
      h.putIssue(1, { labels: ["state:triage"] });
      const before = writes();
      await tick();
      // triage → in-review は表にない。事務局は書き込まず、実行を取り消して、GitHubに合わせる。
      expect(writes()).toEqual(before);
      expect(h.labels(1)).toEqual(["state:triage"]);
      expect(runs()).toMatchObject([{ status: "cancelled" }]);
    });
  });

  describe("着手の条件", () => {
    it("limits.max_parallel を超えて着手しない", async () => {
      const hold = gate();
      h.worker.scripts.set("plan", async (call) => {
        if (call.issue === 1) await hold.wait();
        return undefined;
      });
      h.putIssue(1);
      h.putIssue(2);
      h.putIssue(3);
      await tickNoWait();
      await hold.entered;
      await tickNoWait();
      expect(runs().map((run) => run.issue_number)).toEqual([1]);
      expect(h.labels(2)).toEqual(["state:ready"]);
      expect(h.labels(3)).toEqual(["state:ready"]);

      // 1件目がPRになったら(クローズ待ち)、枠が空く。
      hold.open();
      await supervisor.idle();
      await tick();
      expect(runs().map((run) => run.issue_number)).toEqual([1, 2]);
      expect(h.labels(3)).toEqual(["state:ready"]);
    });

    it("max_parallel が2なら、2件まで同時に進める", async () => {
      setFactoryYml(["max_parallel: 1", "max_parallel: 2"]);
      h.putIssue(1);
      h.putIssue(2);
      h.putIssue(3);
      const hold = gate();
      h.worker.scripts.set("plan", async () => {
        await hold.wait();
        return undefined;
      });
      await tickNoWait();
      expect(runs().map((run) => run.issue_number)).toEqual([1, 2]);
      expect(supervisor.activeRunIds()).toHaveLength(2);
      hold.open();
      await supervisor.idle();
    });

    it("優先度の高い順、同じなら番号の若い順に着手する", async () => {
      h.putIssue(1);
      h.putIssue(2, { labels: ["state:ready", "priority:p2"] });
      h.putIssue(3, { labels: ["state:ready", "priority:p0"] });
      h.putIssue(4, { labels: ["state:ready", "priority:p0"] });
      for (let i = 0; i < 5; i += 1) await tick();
      expect(runs().map((run) => run.issue_number)).toEqual([3, 4, 2, 1]);
    });

    it("1日の実行数が上限に達すると着手せず、ready のまま残る。日付が変わると着手する", async () => {
      supervisor = h.newSupervisor({ dailyRunLimit: 1 });
      h.clock.time = "2026-03-01T22:00:00.000Z";
      h.putIssue(1);
      h.putIssue(2);
      await tick();
      await tick();
      await tick();
      expect(runs().map((run) => run.issue_number)).toEqual([1]);
      expect(h.labels(1)).toEqual(["state:in-review"]);
      expect(h.labels(2)).toEqual(["state:ready"]);
      expect(h.state(2)).toBe("ready");
      expect(logged("intake.skipped").at(-1)?.fields.reasons).toEqual({
        daily_limit: 1,
      });

      // 同じ日のうちは、着手しない。
      h.clock.time = "2026-03-01T23:59:00.000Z";
      await tick();
      expect(runs()).toHaveLength(1);

      h.clock.time = "2026-03-02T00:00:00.000Z";
      await tick();
      expect(runs().map((run) => run.issue_number)).toEqual([1, 2]);
      expect(h.labels(2)).toEqual(["state:in-progress"]);
    });

    it("起票者が allowed_authors にいないイシューには着手しない", async () => {
      h.putIssue(1, { author: "stranger" });
      await tick();
      await tick();
      expect(runs()).toEqual([]);
      expect(h.labels(1)).toEqual(["state:ready"]);
      expect(writes()).toEqual([]);
    });

    it("agent:skip の付いたイシューには着手しない。外されたら着手する", async () => {
      h.putIssue(1, { labels: ["state:ready", "agent:skip"] });
      await tick();
      expect(runs()).toEqual([]);
      expect(writes()).toEqual([]);

      h.putIssue(1, { labels: ["state:ready"] });
      await tick();
      expect(runs()).toHaveLength(1);
    });

    it("ready 以外のイシューには着手しない", async () => {
      h.putIssue(1, { labels: ["state:triage"] });
      h.putIssue(2, { labels: ["state:needs-info"] });
      h.putIssue(3, { labels: ["state:failed"] });
      await tick();
      expect(runs()).toEqual([]);
      expect(writes()).toEqual([]);
    });

    it("factory.yml が不正なリポジトリでは、着手しない", async () => {
      h.putIssue(1);
      h.fake.file = { sha: "sha-bad", content: "version: 2\n" };
      await h.sync();
      h.db.prepare("UPDATE repos SET factory_yml = NULL").run();
      await tick();
      expect(runs()).toEqual([]);
      expect(logged("intake.repo_skipped")).not.toEqual([]);
    });
  });

  describe("質問", () => {
    beforeEach(() => {
      h.worker.answer("plan", {
        status: "question",
        summary: "AとBのどちらですか",
      });
    });

    it("ワーカーが質問を返すと、質問が目印つきでコメントされ、needs-info になる", async () => {
      h.putIssue(1);
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:needs-info"]);
      expect(h.state(1)).toBe("needs-info");
      const comments = factoryComments(1);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("AとBのどちらですか");
      expect(comments[0]?.body).toContain(questionMarker(1));
      expect(runs()).toMatchObject([{ status: "question" }]);
      // 質問での終了は、試行に数えない。
      expect(nextAttempt(h.db, REPO, 1)).toBe(1);

      await tick();
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(runs()).toHaveLength(1);
    });

    it("コメントの後、ラベルを変える前に止まっても、質問を重ねて書かない", async () => {
      h.putIssue(1);
      await tick();
      // ラベルの付け替えの途中で失敗させる。
      const removeLabel = h.fake.removeLabel.bind(h.fake);
      h.fake.removeLabel = () => Promise.reject(new Error("boom"));
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(logged("run.settle_failed")).toHaveLength(1);

      h.fake.removeLabel = removeLabel;
      await tick();
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
      expect(h.state(1)).toBe("needs-info");
    });

    it("質問のコメントには、質問と、実行ごとの目印を書く", () => {
      expect(questionComment(12, " どちらですか \n")).toBe(
        [
          "作業を進める前に、確認したいことがあります。",
          "",
          "どちらですか",
          "",
          "<!-- factory:question run=12 -->",
        ].join("\n"),
      );
    });
  });

  describe("人間の対応待ち(needs_approval と forbidden)", () => {
    /** implement が、パス `file` に触れるコミットを作る。 */
    const touch = (file: string) => {
      h.worker.scripts.set("implement", (call) => {
        h.worker.commitPath(call.repo, call.issue, file);
        return { status: "done", summary: "touched a guarded path" };
      });
    };

    it("needs_approval で止まると、理由が目印つきでコメントされ、needs-info になり、自動で再試行されない", async () => {
      touch("docs/guide.md");
      h.putIssue(1);
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:needs-info"]);
      expect(h.state(1)).toBe("needs-info");
      expect(runs()).toMatchObject([{ attempt: 1, status: "held" }]);
      const comments = factoryComments(1);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("`needs_approval`");
      expect(comments[0]?.body).toContain("`docs/guide.md`");
      expect(comments[0]?.body).toContain("`docs/**`");
      expect(comments[0]?.body).toContain(heldMarker(1));
      // push もPRの作成もしていない。
      expect(labelWrites()).not.toContain("PR");
      expect(h.fake.pullRequests).toEqual([]);
      // 試行に数えない。
      expect(nextAttempt(h.db, REPO, 1)).toBe(1);

      // 待機時間に当たる時間が過ぎても、ready に戻らず、新しい実行も始まらない。
      const before = writes();
      const calls = h.worker.calls.length;
      for (const minutes of [6, 31, 121]) {
        wait(minutes);
        await tick();
      }
      expect(writes()).toEqual(before);
      expect(h.worker.calls).toHaveLength(calls);
      expect(runs()).toHaveLength(1);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
    });

    it("forbidden で止まった場合も、同じく人間の対応待ちになる", async () => {
      touch("generated/out.txt");
      h.putIssue(1);
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:needs-info"]);
      expect(runs()).toMatchObject([{ attempt: 1, status: "held" }]);
      const comments = factoryComments(1);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("`forbidden`");
      expect(comments[0]?.body).toContain("`generated/out.txt`");
      expect(comments[0]?.body).toContain("`generated/**`");
      expect(nextAttempt(h.db, REPO, 1)).toBe(1);

      wait(121);
      await tick();
      expect(runs()).toHaveLength(1);
    });

    it("コメントの後、ラベルを変える前に止まっても、コメントを重ねて書かない", async () => {
      touch("docs/guide.md");
      h.putIssue(1);
      await tick();
      // 状態のラベルの付け替えだけを、途中で失敗させる。
      const removeLabel = h.fake.removeLabel.bind(h.fake);
      h.fake.removeLabel = (repo, issue, label) =>
        label.startsWith("state:")
          ? Promise.reject(new Error("boom"))
          : removeLabel(repo, issue, label);
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(logged("run.settle_failed")).toHaveLength(1);

      h.fake.removeLabel = removeLabel;
      await tick();
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
    });

    it("コメントの前に止まっても、起動し直すとコメントして needs-info になる", async () => {
      touch("docs/guide.md");
      h.putIssue(1);
      await tick();
      await supervisor.stop(1000);
      expect(factoryComments(1)).toEqual([]);

      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
    });

    it("人間が ready に戻すと、新しい実行として着手し、止まれば、その実行の目印でもう一度コメントする", async () => {
      touch("docs/guide.md");
      h.putIssue(1);
      await tick();
      await tick();
      h.putIssue(1, { labels: ["state:ready"] });
      await tick();
      await tick();
      expect(runs()).toMatchObject([
        { attempt: 1, status: "held" },
        { attempt: 1, status: "held" },
      ]);
      expect(factoryComments(1).map((comment) => comment.body)).toEqual([
        expect.stringContaining(heldMarker(1)),
        expect.stringContaining(heldMarker(2)),
      ]);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
    });

    it("止まった後に人間が状態を変えていたら、コメントも状態の変更もしない", async () => {
      touch("docs/guide.md");
      h.putIssue(1);
      await tick();
      await supervisor.stop(1000);
      h.putIssue(1, { labels: ["state:triage"] });
      const before = writes();

      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(writes()).toEqual(before);
      expect(h.labels(1)).toEqual(["state:triage"]);
    });

    it("dry_run の間は、コメントも状態の変更もしない", async () => {
      touch("docs/guide.md");
      h.putIssue(1);
      await tick();
      await supervisor.stop(1000);
      const before = h.fake.writes.length;

      h.dryRun = true;
      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(h.fake.writes).toHaveLength(before);
      expect(factoryComments(1)).toEqual([]);
      expect(h.state(1)).toBe("in-progress");
      expect(logged("run.held").map((line) => line.fields.action)).toContain(
        "hold",
      );
    });

    describe("人間の承認(agent:approved)", () => {
      const approvals = () =>
        h.db
          .prepare(
            "SELECT run_id, head_commit, used_at IS NOT NULL AS used FROM approvals ORDER BY id",
          )
          .all() as { run_id: number; head_commit: string; used: number }[];
      const stepNames = (runId = 1) =>
        listSteps(h.db, runId).map((step) => `${step.name}:${step.status}`);
      const heldCommit = (runId = 1): string => {
        const step = listSteps(h.db, runId).findLast(
          (candidate) => candidate.status === "held",
        );
        return (JSON.parse(step?.output ?? "{}") as { headCommit: string })
          .headCommit;
      };
      /** 人間が、いまのラベルに `agent:approved` を足す。 */
      const approveByLabel = (issue = 1) =>
        h.putIssue(issue, { labels: [...h.labels(issue), "agent:approved"] });
      /** 保護対象のパスに触れて止まり、needs-info で待っている状態にする。 */
      const holdForApproval = async () => {
        touch("docs/guide.md");
        h.putIssue(1);
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:needs-info"]);
      };

      it("ラベルを付けると、止まったときのコミットのまま、publish からやり直してPRを作る", async () => {
        await holdForApproval();
        const head = heldCommit();
        const calls = h.worker.calls.length;

        approveByLabel();
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:in-review"]);
        expect(h.state(1)).toBe("in-review");
        expect(h.fake.pullRequests).toHaveLength(1);
        expect(h.fake.pullRequests[0]?.body).toContain(
          "## 承認された保護対象のパス",
        );
        expect(h.fake.pullRequests[0]?.body).toContain("`docs/guide.md`");
        expect(approvals()).toEqual([
          { run_id: 1, head_commit: head, used: 1 },
        ]);
        // 同じ実行の publish だけをやり直す。plan も implement も呼ばない。
        expect(h.worker.calls).toHaveLength(calls);
        expect(runs()).toMatchObject([{ id: 1, status: "running" }]);
        expect(stepNames()).toEqual([
          "prepare:done",
          "plan:done",
          "implement:done",
          "verify:done",
          "review:done",
          "publish:held",
          "publish:done",
        ]);
        expect(listSteps(h.db, 1).at(-1)?.output).toContain(head);
        expect(nextAttempt(h.db, REPO, 1)).toBe(1);

        // その後は、何度回しても何も書かない。
        const before = writes();
        await tick();
        await tick();
        expect(writes()).toEqual(before);
        expect(factoryComments(1)).toHaveLength(1);
      });

      it("止まった後にコミットが変わっていれば、承認は効かず、もう一度コメントして待つ。新しいコミットは、もう一度承認できる", async () => {
        await holdForApproval();
        const first = heldCommit();
        const second = h.worker.commitPath(REPO, 1, "docs/more.md");

        approveByLabel();
        await tick();
        await tick();
        expect(h.fake.pullRequests).toEqual([]);
        expect(h.labels(1)).toEqual(["state:needs-info"]);
        expect(runs()).toMatchObject([{ id: 1, status: "held" }]);
        expect(approvals()).toEqual([
          { run_id: 1, head_commit: first, used: 1 },
        ]);
        const comments = factoryComments(1);
        expect(comments).toHaveLength(2);
        expect(comments[1]?.body).toContain("`needs_approval`");
        expect(comments[1]?.body).toContain(`\`${second}\``);
        expect(comments[1]?.body).toContain(heldMarker(1, 2));

        // 待っている間は、何もしない。
        const before = writes();
        await tick();
        expect(writes()).toEqual(before);

        approveByLabel();
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:in-review"]);
        expect(h.fake.pullRequests).toHaveLength(1);
        expect(approvals()).toEqual([
          { run_id: 1, head_commit: first, used: 1 },
          { run_id: 1, head_commit: second, used: 1 },
        ]);
        expect(factoryComments(1)).toHaveLength(2);
      });

      it("forbidden で止まった変更は、ラベルを付けても通らない", async () => {
        touch("generated/out.txt");
        h.putIssue(1);
        await tick();
        await tick();
        const before = writes();

        approveByLabel();
        await tick();
        await tick();
        expect(writes()).toEqual(before);
        expect(approvals()).toEqual([]);
        expect(h.fake.pullRequests).toEqual([]);
        expect(h.state(1)).toBe("needs-info");
        expect(runs()).toMatchObject([{ status: "held" }]);
      });

      it("質問で待っているイシューにラベルを付けても、何も起きない", async () => {
        h.worker.answer("plan", {
          status: "question",
          summary: "どちらですか",
        });
        h.putIssue(1);
        await tick();
        await tick();
        const before = writes();

        approveByLabel();
        await tick();
        await tick();
        expect(writes()).toEqual(before);
        expect(approvals()).toEqual([]);
        expect(h.state(1)).toBe("needs-info");
      });

      it("止まる前から付いていたラベルは、承認として扱わず、止まるときに外す", async () => {
        touch("docs/guide.md");
        h.putIssue(1, { labels: ["state:ready", "agent:approved"] });
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:needs-info"]);
        expect(factoryComments(1)).toHaveLength(1);

        await tick();
        await tick();
        expect(h.fake.pullRequests).toEqual([]);
        expect(approvals()).toEqual([]);
        expect(runs()).toMatchObject([{ status: "held" }]);
        expect(h.state(1)).toBe("needs-info");
      });

      it("承認して止まった後に ready へ戻した新しい実行には、前の承認が効かない", async () => {
        await holdForApproval();
        h.worker.commitPath(REPO, 1, "docs/more.md");
        approveByLabel();
        await tick();
        await tick();
        expect(runs()).toMatchObject([{ id: 1, status: "held" }]);

        h.putIssue(1, { labels: ["state:ready"] });
        await tick();
        await tick();
        expect(runs()).toMatchObject([
          { id: 1, status: "held" },
          { id: 2, status: "held" },
        ]);
        expect(h.fake.pullRequests).toEqual([]);
        expect(h.labels(1)).toEqual(["state:needs-info"]);
        expect(approvals()).toHaveLength(1);
      });

      it("承認を記録した後、状態を変える前に止まっても、承認もPRもコメントも重複しない", async () => {
        await holdForApproval();
        approveByLabel();
        // 状態のラベルの付け替えを、失敗させる。
        const addLabels = h.fake.addLabels.bind(h.fake);
        h.fake.addLabels = () => Promise.reject(new Error("boom"));
        await tick();
        expect(logged("run.settle_failed")).toHaveLength(1);
        expect(approvals()).toMatchObject([{ run_id: 1, used: 0 }]);
        expect(h.state(1)).toBe("needs-info");
        // ラベルは外し終わっている。記録が残っているので、続きから進む。
        expect(h.labels(1)).toEqual(["state:needs-info"]);

        h.fake.addLabels = addLabels;
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:in-review"]);
        expect(h.fake.pullRequests).toHaveLength(1);
        expect(approvals()).toMatchObject([{ run_id: 1, used: 1 }]);
        expect(factoryComments(1)).toHaveLength(1);
      });

      it("in-progress に進めた後、再開の前に止まっても、起動し直すと publish から進む", async () => {
        await holdForApproval();
        const head = heldCommit();
        // 承認を記録し、in-progress に進めたところで、事務局が落ちた状態を作る。
        recordApproval(h.db, h.clock, { runId: 1, headCommit: head });
        h.putIssue(1, { labels: ["state:in-progress"] });
        await supervisor.stop(1000);

        supervisor = h.newSupervisor();
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:in-review"]);
        expect(h.fake.pullRequests).toHaveLength(1);
        expect(approvals()).toEqual([
          { run_id: 1, head_commit: head, used: 1 },
        ]);
        expect(factoryComments(1)).toHaveLength(1);
      });

      it("コメントの後、状態を変える前に付いたラベルは、やり直しで外さず、承認として扱う", async () => {
        touch("docs/guide.md");
        h.putIssue(1);
        await tick();
        const removeLabel = h.fake.removeLabel.bind(h.fake);
        h.fake.removeLabel = (repo, issue, label) =>
          label.startsWith("state:")
            ? Promise.reject(new Error("boom"))
            : removeLabel(repo, issue, label);
        await tick();
        expect(factoryComments(1)).toHaveLength(1);
        h.fake.removeLabel = removeLabel;

        // コメントを見た人間が、状態が変わる前に承認した。
        approveByLabel();
        await tick();
        expect(h.labels(1)).toEqual(["state:needs-info", "agent:approved"]);
        await tick();
        await tick();
        expect(h.labels(1)).toEqual(["state:in-review"]);
        expect(h.fake.pullRequests).toHaveLength(1);
      });

      it("再開した publish が失敗したら、通常の失敗と同じく ready に戻る。承認は、次の実行には効かない", async () => {
        await holdForApproval();
        approveByLabel();
        // PRの作成を失敗させる。
        const createPullRequest = h.fake.createPullRequest.bind(h.fake);
        h.fake.createPullRequest = () => Promise.reject(new Error("boom"));
        await tick();
        h.fake.createPullRequest = createPullRequest;
        expect(h.fake.pullRequests).toEqual([]);
        expect(runs()).toMatchObject([{ id: 1, status: "failed" }]);
        // 失敗した実行は、通常の失敗と同じく ready に戻る。承認は使用済みで、次の実行には効かない。
        await tick();
        expect(h.labels(1)).toEqual(["state:ready"]);
        expect(approvals()).toMatchObject([{ run_id: 1, used: 1 }]);
      });

      it("dry_run の間は、承認を記録せず、ラベルも外さず、状態も変えない", async () => {
        await holdForApproval();
        await supervisor.stop(1000);
        approveByLabel();
        const before = h.fake.writes.length;

        h.dryRun = true;
        supervisor = h.newSupervisor();
        await tick();
        await tick();
        expect(h.fake.writes).toHaveLength(before);
        expect(approvals()).toEqual([]);
        expect(h.labels(1)).toEqual(["state:needs-info", "agent:approved"]);
        expect(h.state(1)).toBe("needs-info");
        expect(runs()).toMatchObject([{ status: "held" }]);
        expect(logged("run.held").map((line) => line.fields.action)).toContain(
          "approve",
        );
      });
    });

    describe("コメントの本文", () => {
      const hit = (path: string, pattern: string) => ({ path, pattern });

      it("needs_approval では、承認の方法(ラベル)と、効く範囲を書く", () => {
        const body = heldComment(1, {
          status: "needs_approval",
          headCommit: "abc",
          forbidden: [],
          protected: [hit("CLAUDE.md", "CLAUDE.md")],
        });
        expect(body).toContain("`agent:approved`");
        expect(body).toContain("承認が効くのは、上のコミットだけ");
      });

      it("forbidden では、承認の方法を書かない", () => {
        const body = heldComment(1, {
          status: "forbidden",
          headCommit: "abc",
          forbidden: [hit("a", "a")],
          protected: [],
        });
        expect(body).not.toContain("agent:approved");
      });

      it("再開した publish がまた止まったときは、回数の入った目印を付ける", () => {
        const output = {
          status: "needs_approval" as const,
          headCommit: "abc",
          forbidden: [],
          protected: [hit("a", "a")],
        };
        expect(heldComment(5, output, 1)).toContain(
          "<!-- factory:held run=5 -->",
        );
        const second = heldComment(5, output, 2);
        expect(second).toContain("<!-- factory:held run=5 publish=2 -->");
        expect(second).not.toContain(heldMarker(5));
      });

      it("結果の種類、コミット、当たったパスとパターン、実行ごとの目印を書く", () => {
        const body = heldComment(12, {
          status: "needs_approval",
          headCommit: "0123456789abcdef0123456789abcdef01234567",
          forbidden: [],
          protected: [
            hit(".github/workflows/ci.yml", ".github/**"),
            hit("CLAUDE.md", "CLAUDE.md"),
          ],
        });
        expect(body).toContain("`needs_approval`");
        expect(body).toContain("paths.protected");
        expect(body).toContain("`0123456789abcdef0123456789abcdef01234567`");
        expect(body).toContain(
          "- `.github/workflows/ci.yml`(パターン: `.github/**`)",
        );
        expect(body).toContain("- `CLAUDE.md`(パターン: `CLAUDE.md`)");
        expect(body).toContain("再試行しません");
        expect(body.trimEnd().endsWith("<!-- factory:held run=12 -->")).toBe(
          true,
        );
      });

      it("forbidden では、禁止のパスを挙げる", () => {
        const body = heldComment(3, {
          status: "forbidden",
          headCommit: "abc",
          forbidden: [hit("migrations/001.sql", "migrations/**")],
          protected: [hit("CLAUDE.md", "CLAUDE.md")],
        });
        expect(body).toContain("`forbidden`");
        expect(body).toContain("paths.forbidden");
        expect(body).toContain(
          "- `migrations/001.sql`(パターン: `migrations/**`)",
        );
        // forbidden で止まったときは、禁止のパスだけを挙げる。
        expect(body).not.toContain("- `CLAUDE.md`");
      });

      it("同じ入力からは、同じ本文になる", () => {
        const input = {
          status: "forbidden" as const,
          headCommit: "abc",
          forbidden: [hit("a", "a")],
          protected: [],
        };
        expect(heldComment(1, input)).toBe(heldComment(1, input));
      });

      it("パスは50件までで、残りは件数だけを書く", () => {
        const body = heldComment(1, {
          status: "forbidden",
          headCommit: "abc",
          forbidden: Array.from({ length: 53 }, (_, index) =>
            hit(`generated/${index}.txt`, "generated/**"),
          ),
          protected: [],
        });
        expect(body.match(/^- `generated\//gm)).toHaveLength(50);
        expect(body).toContain("ほか 3 件");
      });

      it("パスに書かれた記号で、目印の偽装、メンション、コードの外への抜け出しが起きない", () => {
        const body = heldComment(1, {
          status: "forbidden",
          headCommit: "abc",
          forbidden: [
            hit("a/<!-- factory:held run=2 -->", "a/**"),
            hit("b/`@someone`\nline", "b/**"),
          ],
          protected: [],
        });
        expect(body).not.toContain(heldMarker(2));
        expect(body.match(/<!--/g)).toHaveLength(1);
        expect(body).toContain("- `b/'@someone' line`(パターン: `b/**`)");
      });

      it("記録から内容を読めなければ、そのことを書く", () => {
        const body = heldComment(4, null);
        expect(body).toContain("記録から読めませんでした");
        expect(body).toContain(heldMarker(4));
      });
    });
  });

  describe("失敗と再試行", () => {
    it("失敗すると ready に戻り、待機時間が過ぎるまで再試行されない", async () => {
      h.worker.answer("plan", fail);
      h.putIssue(1);
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:ready"]);
      expect(h.state(1)).toBe("ready");
      expect(runs()).toMatchObject([{ attempt: 1, status: "failed" }]);

      await tick();
      wait(4);
      await tick();
      expect(runs()).toHaveLength(1);
      expect(logged("intake.skipped").at(-1)?.fields.reasons).toEqual({
        waiting_retry: 1,
      });

      wait(2);
      await tick();
      expect(runs()).toMatchObject([
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "running" },
      ]);
    });

    it("limits.max_attempts に達すると failed になり、もう着手しない", async () => {
      h.worker.answer("plan", fail, fail, fail);
      h.putIssue(1);
      await tick();
      await tick();
      wait(6);
      await tick();
      await tick();
      // 2回目の失敗の後は、30分待つ。
      wait(6);
      await tick();
      expect(runs()).toHaveLength(2);
      wait(30);
      await tick();
      await tick();

      expect(runs()).toMatchObject([
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "failed" },
        { attempt: 3, status: "failed" },
      ]);
      expect(h.labels(1)).toEqual(["state:failed"]);
      expect(h.state(1)).toBe("failed");

      wait(600);
      await tick();
      await tick();
      expect(runs()).toHaveLength(3);
    });

    it("max_attempts は製品の factory.yml から読む", async () => {
      setFactoryYml(["max_attempts: 3", "max_attempts: 1"]);
      h.worker.answer("plan", fail);
      h.putIssue(1);
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:failed"]);
    });
  });

  describe("failed からの復帰", () => {
    const failThreeTimes = async () => {
      h.worker.answer("plan", fail, fail, fail);
      h.putIssue(1);
      for (let i = 0; i < 3; i += 1) {
        await tick();
        await tick();
        wait(31);
      }
      expect(h.labels(1)).toEqual(["state:failed"]);
    };

    it("人間がラベルを手で変えて戻すと、試行回数がリセットされ、次の実行が1回目になる", async () => {
      await failThreeTimes();
      h.putIssue(1, { labels: ["state:ready"] });
      await tick();

      const all = runs();
      expect(all).toHaveLength(4);
      expect(
        all.slice(0, 3).every((run) => run.attempt_reset_at !== null),
      ).toBe(true);
      expect(all[3]).toMatchObject({ attempt: 1, attempt_reset_at: null });
    });

    it("2回同期しても、結果が変わらない", async () => {
      await failThreeTimes();
      h.putIssue(1, { labels: ["state:triage"] });
      await tick();
      const before = runs();
      expect(before.every((run) => run.attempt_reset_at !== null)).toBe(true);
      expect(nextAttempt(h.db, REPO, 1)).toBe(1);

      await tick();
      await tick();
      expect(runs()).toEqual(before);
      expect(logged("run.attempts_reset")).toHaveLength(1);
    });

    it("戻した後の失敗は、前の復帰の記録でリセットされない", async () => {
      await failThreeTimes();
      h.putIssue(1, { labels: ["state:ready"] });
      h.worker.answer("plan", fail);
      await tick();
      await tick();
      await tick();
      expect(runs().at(-1)).toMatchObject({
        attempt: 1,
        status: "failed",
        attempt_reset_at: null,
      });
      expect(nextAttempt(h.db, REPO, 1)).toBe(2);
    });
  });

  describe("再開", () => {
    it("起動し直すと、終わっていない実行を続きから進め、PRが重複しない", async () => {
      const hold = gate();
      h.worker.scripts.set("review", async () => {
        await hold.wait();
        return undefined;
      });
      h.putIssue(1);
      await tickNoWait();
      await hold.entered;

      // 事務局を止める。実行中のステップは、そのまま残る。
      const stopping = supervisor.stop(1000);
      hold.open();
      expect(await stopping).toBe(true);
      expect(findResumableRuns(h.db)).toMatchObject([
        { step: "review", interrupted: true },
      ]);
      expect(h.fake.pullRequests).toEqual([]);

      // 起動し直す。
      h.worker.scripts.delete("review");
      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:in-review"]);
      expect(h.fake.pullRequests).toHaveLength(1);
      expect(runs()).toMatchObject([{ attempt: 1, status: "running" }]);
      expect(
        listSteps(h.db, 1).map((step) => `${step.name}:${step.status}`),
      ).toEqual([
        "prepare:done",
        "plan:done",
        "implement:done",
        "verify:done",
        "review:done",
        "publish:done",
      ]);
      expect(h.worker.callsOf("plan")).toHaveLength(1);
      expect(h.worker.callsOf("implement")).toHaveLength(1);
    });

    it("PRを作った後、ラベルを変える前に止まっても、PRは1つのまま in-review になる", async () => {
      h.putIssue(1);
      await tick();
      expect(h.labels(1)).toEqual(["state:in-progress"]);
      await supervisor.stop(1000);

      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:in-review"]);
      expect(h.fake.pullRequests).toHaveLength(1);
      expect(
        writes().filter((method) => method === "createPullRequest"),
      ).toHaveLength(1);
    });

    it("実行を記録した後、ラベルを変える前に止まっても、着手の続きから進む", async () => {
      h.putIssue(1);
      await h.sync();
      startRun(h.db, h.clock, { repo: REPO, issueNumber: 1 });

      await tick();
      expect(h.labels(1)).toEqual(["state:in-progress"]);
      expect(runs()).toHaveLength(1);
      expect(h.fake.pullRequests).toHaveLength(1);
    });

    it("質問で終わった後、コメントの前に止まっても、起動し直すとコメントして needs-info になる", async () => {
      h.worker.answer("plan", { status: "question", summary: "どちらですか" });
      h.putIssue(1);
      await tick();
      await supervisor.stop(1000);
      expect(factoryComments(1)).toEqual([]);

      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(factoryComments(1)).toHaveLength(1);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
    });
  });

  describe("人間によるラベルの変更", () => {
    it("実行中に人間がラベルを変えると、実行が取り消され、GitHubの状態に合わせられる", async () => {
      const hold = gate();
      h.worker.scripts.set("implement", async () => {
        await hold.wait();
        return undefined;
      });
      h.putIssue(1);
      await tickNoWait();
      await hold.entered;

      h.putIssue(1, { labels: ["state:needs-info"] });
      const before = writes();
      await tickNoWait();
      expect(runs()).toMatchObject([{ status: "cancelled" }]);
      expect(h.state(1)).toBe("needs-info");
      expect(logged("run.cancelled")).toHaveLength(1);

      // 止められたワーカーの結果は、使わない。
      hold.open();
      await supervisor.idle();
      await tick();
      expect(
        listSteps(h.db, 1).map((step) => `${step.name}:${step.status}`),
      ).toEqual(["prepare:done", "plan:done", "implement:cancelled"]);
      expect(h.labels(1)).toEqual(["state:needs-info"]);
      expect(writes()).toEqual(before);
      expect(h.fake.pullRequests).toEqual([]);
      // 取り消しは、試行に数えない。
      expect(nextAttempt(h.db, REPO, 1)).toBe(1);
    });

    it("実行中にイシューがクローズされても、取り消す", async () => {
      const hold = gate();
      h.worker.scripts.set("plan", async () => {
        await hold.wait();
        return undefined;
      });
      h.putIssue(1);
      await tickNoWait();
      await hold.entered;
      h.putIssue(1, { labels: ["state:in-progress"], open: false });
      await tickNoWait();
      hold.open();
      await supervisor.idle();
      expect(runs()).toMatchObject([{ status: "cancelled" }]);
    });

    it("人間が ready に戻したら、取り消した後、新しい実行として着手する", async () => {
      const hold = gate();
      h.worker.scripts.set("plan", async (call) => {
        if (h.worker.callsOf("plan").length === 1 && call.issue === 1) {
          await hold.wait();
        }
        return undefined;
      });
      h.putIssue(1);
      await tickNoWait();
      await hold.entered;
      h.putIssue(1, { labels: ["state:ready"] });
      await tickNoWait();
      hold.open();
      await supervisor.idle();
      await tick();
      expect(runs()).toMatchObject([
        { attempt: 1, status: "cancelled" },
        { attempt: 1, status: "running" },
      ]);
    });
  });

  describe("dry_run", () => {
    it("dry_run が true のとき、着手せず、GitHubへの書き込みが1回も行われない", async () => {
      h.dryRun = true;
      supervisor = h.newSupervisor();
      h.putIssue(1);
      h.putIssue(2, { labels: [] });
      await tick();
      await tick();
      expect(h.fake.writes).toEqual([]);
      expect(runs()).toEqual([]);
      expect(h.worker.calls).toEqual([]);
      expect(h.launcher.requests).toEqual([]);
    });

    it("途中の実行があっても、dry_run の間は進めず、書き込まない", async () => {
      // dry_run でない間に、質問で終わった実行と、途中の実行を作っておく。
      setFactoryYml(["max_parallel: 1", "max_parallel: 2"]);
      const hold = gate();
      h.worker.scripts.set("plan", async (call) => {
        if (call.issue === 1) {
          return { status: "question", summary: "どちらですか" };
        }
        await hold.wait();
        return undefined;
      });
      h.putIssue(1);
      h.putIssue(2);
      await tickNoWait();
      await hold.entered;
      await expect.poll(() => runs()[0]?.status).toBe("question");
      const stopping = supervisor.stop(1000);
      hold.open();
      await stopping;
      const before = h.fake.writes.length;
      const calls = h.worker.calls.length;

      h.dryRun = true;
      supervisor = h.newSupervisor();
      await tick();
      await tick();
      expect(h.fake.writes).toHaveLength(before);
      expect(h.worker.calls).toHaveLength(calls);
      expect(factoryComments(1)).toEqual([]);
      expect(runs().map((run) => run.status)).toEqual(["question", "running"]);
      expect(logged("run.held").map((line) => line.fields.action)).toContain(
        "ask",
      );
    });

    it("dry_run の間も、人間が状態を変えた実行は取り消す", async () => {
      h.putIssue(1);
      await tick();
      await supervisor.stop(1000);
      h.dryRun = true;
      supervisor = h.newSupervisor();
      h.putIssue(1, { labels: ["state:triage"] });
      const before = h.fake.writes.length;
      await tick();
      expect(runs()).toMatchObject([{ status: "cancelled" }]);
      expect(h.fake.writes).toHaveLength(before);
    });
  });

  describe("失敗の隔離", () => {
    it("1つの実行の後処理が失敗しても、同期とほかの実行は止まらない", async () => {
      setFactoryYml(["max_parallel: 1", "max_parallel: 2"]);
      h.worker.scripts.set("plan", (call) =>
        call.issue === 1
          ? { status: "question", summary: "どちらですか" }
          : undefined,
      );
      h.putIssue(1);
      h.putIssue(2);
      await tick();
      // イシュー1の後処理(コメントの確認)だけを失敗させる。
      h.fake.listCommentsOnIssue = () => Promise.reject(new Error("boom"));
      await tick();
      await tick();

      expect(logged("run.settle_failed").length).toBeGreaterThan(0);
      expect(h.labels(1)).toEqual(["state:in-progress"]);
      expect(h.labels(2)).toEqual(["state:in-review"]);
      // 同期は続いている。
      h.putIssue(3, { labels: ["state:triage"] });
      await tick();
      expect(h.state(3)).toBe("triage");
    });

    it("1つの実行が例外で止まっても、ほかの実行は進む", async () => {
      setFactoryYml(["max_parallel: 1", "max_parallel: 2"]);
      h.worker.scripts.set("plan", (call) => {
        if (call.issue === 1) throw new Error("boom");
        return undefined;
      });
      h.putIssue(1);
      h.putIssue(2);
      await tick();
      await tick();
      expect(h.labels(1)).toEqual(["state:ready"]);
      expect(h.labels(2)).toEqual(["state:in-review"]);
      expect(runs().map((run) => run.status)).toEqual(["failed", "running"]);
    });

    it("記録が読めないリポジトリがあっても、ほかのリポジトリは進む", async () => {
      h.putIssue(1);
      await h.sync();
      await supervisor.tick(["owner/other", REPO]);
      await supervisor.idle();
      expect(logged("intake.repo_skipped")).toHaveLength(1);
      expect(h.labels(1)).toEqual(["state:in-progress"]);
    });
  });

  describe("停止", () => {
    it("進めている実行がなければ、すぐに止まる", async () => {
      expect(await supervisor.stop(10)).toBe(true);
    });

    it("止めた後は、着手しない", async () => {
      await supervisor.stop(10);
      h.putIssue(1);
      await tick();
      expect(runs()).toEqual([]);
      expect(writes()).toEqual([]);
    });

    it("実行中のステップは待たずに止め、実行中のまま残す。猶予を過ぎたら待つのをやめる", async () => {
      const hold = gate();
      h.worker.scripts.set("implement", async () => {
        await hold.wait();
        return undefined;
      });
      h.putIssue(1);
      await tickNoWait();
      await hold.entered;

      expect(await supervisor.stop(20)).toBe(false);
      expect(findResumableRuns(h.db)).toMatchObject([
        { step: "implement", interrupted: true },
      ]);
      hold.open();
      await supervisor.idle();
      // 止めた後に返ってきた結果は、記録しない。
      expect(findResumableRuns(h.db)).toMatchObject([
        { step: "implement", interrupted: true },
      ]);
      expect(h.labels(1)).toEqual(["state:in-progress"]);
    });
  });

  describe("作業場所の後片付け", () => {
    const question = { status: "question", summary: "どちらですか" } as const;
    const paths = (issue: number) => workspacePaths(h.dirs, REPO, issue);
    const exists = (issue: number) => fs.existsSync(paths(issue).issueDir);
    /** 作業場所の、作業用のブランチの先頭。 */
    const branchHead = (issue: number) =>
      unconfiguredGit(
        paths(issue).repoDir,
        "rev-parse",
        `agent/issue-${issue}`,
      );
    /** 作業場所のcloneに、そのコミットがあるか。 */
    const hasCommit = (issue: number, commit: string) => {
      try {
        unconfiguredGit(paths(issue).repoDir, "cat-file", "-e", commit);
        return true;
      } catch {
        return false;
      }
    };
    /** 試行の上限まで失敗させて、failed にする。作業場所には、コミットを1つ残す。 */
    const failToLimit = async (): Promise<string> => {
      h.worker.answer("plan", fail, fail, fail);
      h.putIssue(1);
      for (let i = 0; i < 3; i += 1) {
        await tick();
        await tick();
        wait(31);
      }
      expect(h.labels(1)).toEqual(["state:failed"]);
      return h.worker.commit(REPO, 1);
    };
    /** 次の plan が呼ばれた時点の、作業用のブランチの先頭を控える。 */
    const headAtNextPlan = () => {
      const seen: string[] = [];
      h.worker.scripts.set("plan", (call) => {
        seen.push(branchHead(call.issue));
        return undefined;
      });
      return seen;
    };

    describe("クローズされたイシュー", () => {
      it("質問で終わったままクローズされたら、作業場所が消える", async () => {
        h.worker.answer("plan", question);
        h.putIssue(1);
        await tick();
        await tick();
        expect(h.state(1)).toBe("needs-info");
        expect(exists(1)).toBe(true);

        h.putIssue(1, { labels: ["state:needs-info"], open: false });
        await tick();

        expect(exists(1)).toBe(false);
        expect(runs()).toMatchObject([{ status: "question" }]);
        expect(logged("workspace.removed").map((line) => line.fields)).toEqual([
          { repo: REPO, issue: 1, reason: "closed" },
        ]);
      });

      it("試行の上限に達して failed になったままクローズされたら、作業場所が消える", async () => {
        await failToLimit();
        expect(exists(1)).toBe(true);

        h.putIssue(1, { labels: ["state:failed"], open: false });
        await tick();

        expect(exists(1)).toBe(false);
      });

      it("実行中にクローズされたら、実行を止め終えてから消す", async () => {
        const hold = gate();
        h.worker.scripts.set("implement", async () => {
          await hold.wait();
          return undefined;
        });
        h.putIssue(1);
        await tickNoWait();
        await hold.entered;

        h.putIssue(1, { labels: ["state:in-progress"], open: false });
        await tickNoWait();
        // 取り消したが、ワーカーはまだ止まっていない。
        expect(runs()).toMatchObject([{ status: "cancelled" }]);
        expect(exists(1)).toBe(true);
        await tickNoWait();
        expect(exists(1)).toBe(true);

        hold.open();
        await supervisor.idle();
        await tick();
        expect(exists(1)).toBe(false);
        expect(h.fake.pullRequests).toEqual([]);
      });
    });

    describe("failed から戻されたイシュー", () => {
      it("人間が戻した後の実行は、前の実行のコミットを含まない作業場所から始まる", async () => {
        const old = await failToLimit();
        expect(branchHead(1)).toBe(old);
        const seen = headAtNextPlan();

        h.putIssue(1, { labels: ["state:ready"] });
        await tick();

        expect(seen).toEqual([plainGit(h.source, "rev-parse", "HEAD")]);
        expect(hasCommit(1, old)).toBe(false);
        expect(runs().at(-1)).toMatchObject({ attempt: 1 });
        expect(logged("workspace.removed").map((line) => line.fields)).toEqual([
          { repo: REPO, issue: 1, reason: "returned_from_failed" },
        ]);
      });

      it("戻した先が ready でなくても消す。戻した後の実行の作業場所は、消さない", async () => {
        await failToLimit();
        h.putIssue(1, { labels: ["state:triage"] });
        await tick();
        expect(exists(1)).toBe(false);

        // 戻した後の実行が質問で終わる。その作業場所は、何度回しても残る。
        h.worker.answer("plan", question);
        h.putIssue(1, { labels: ["state:ready"] });
        await tick();
        await tick();
        expect(h.state(1)).toBe("needs-info");
        expect(exists(1)).toBe(true);
        await tick();
        await tick();
        expect(exists(1)).toBe(true);
        expect(logged("workspace.removed")).toHaveLength(1);
      });

      it("failed のままなら、残す", async () => {
        const old = await failToLimit();
        await tick();
        await tick();
        expect(branchHead(1)).toBe(old);
      });
    });

    describe("残す場合", () => {
      it("失敗の後の再試行では、作業場所が残り、前の実行のコミットから始まる", async () => {
        h.worker.answer("plan", fail);
        h.putIssue(1);
        await tick();
        await tick();
        expect(h.state(1)).toBe("ready");
        const old = h.worker.commit(REPO, 1);
        await tick();
        expect(branchHead(1)).toBe(old);

        const seen = headAtNextPlan();
        wait(6);
        await tick();
        expect(runs()).toMatchObject([
          { attempt: 1, status: "failed" },
          { attempt: 2 },
        ]);
        expect(seen).toEqual([old]);
        expect(logged("workspace.removed")).toEqual([]);
      });

      it("実行中の実行があるイシューの作業場所は、消さない", async () => {
        const hold = gate();
        h.worker.scripts.set("implement", async () => {
          await hold.wait();
          return undefined;
        });
        h.putIssue(1);
        await tickNoWait();
        await hold.entered;
        await tickNoWait();
        await tickNoWait();
        expect(runs()).toMatchObject([{ status: "running" }]);
        expect(exists(1)).toBe(true);

        // PRを作って、クローズを待っている間も残す。
        hold.open();
        await supervisor.idle();
        await tick();
        await tick();
        expect(h.state(1)).toBe("in-review");
        expect(runs()).toMatchObject([{ status: "running" }]);
        expect(exists(1)).toBe(true);
        expect(logged("workspace.removed")).toEqual([]);
      });

      it("起動し直した後も、実行中の実行があるイシューの作業場所は、消さない", async () => {
        const hold = gate();
        h.worker.scripts.set("implement", async () => {
          await hold.wait();
          return undefined;
        });
        h.putIssue(1);
        await tickNoWait();
        await hold.entered;
        const stopping = supervisor.stop(1000);
        hold.open();
        await stopping;

        // dry_run でなければ再開する。再開の前でも、記録が実行中なら残す。
        h.dryRun = true;
        supervisor = h.newSupervisor();
        h.dryRun = false;
        await tick();
        expect(runs()).toMatchObject([{ status: "running" }]);
        expect(exists(1)).toBe(true);
      });

      it("質問で終わった後と、人間の対応待ちの後は、残す", async () => {
        h.worker.answer("plan", question);
        h.putIssue(1);
        await tick();
        await tick();
        await tick();
        expect(h.state(1)).toBe("needs-info");
        expect(exists(1)).toBe(true);
      });

      it("人間のラベル変更で取り消された後は、残す", async () => {
        const hold = gate();
        h.worker.scripts.set("implement", async () => {
          await hold.wait();
          return undefined;
        });
        h.putIssue(1);
        await tickNoWait();
        await hold.entered;
        const old = h.worker.commit(REPO, 1);

        h.putIssue(1, { labels: ["state:triage"] });
        await tickNoWait();
        hold.open();
        await supervisor.idle();
        await tick();
        await tick();

        expect(runs()).toMatchObject([{ status: "cancelled" }]);
        expect(exists(1)).toBe(true);
        expect(hasCommit(1, old)).toBe(true);
        expect(logged("workspace.removed")).toEqual([]);
      });

      it("DBにないイシューの作業場所と、事務局が作る名前でないものには、触れない", async () => {
        h.putIssue(1);
        await tick();
        const parent = path.dirname(paths(1).issueDir);
        fs.mkdirSync(path.join(parent, "issue-99"));
        fs.mkdirSync(path.join(parent, "notes"));

        await tick();
        await tick();

        expect(fs.readdirSync(parent).sort()).toEqual([
          "issue-1",
          "issue-99",
          "notes",
        ]);
      });
    });

    it("2回行っても、結果が変わらない。ミラーと、ほかのイシューの作業場所には触れない", async () => {
      h.worker.answer("plan", question, question);
      h.putIssue(1);
      h.putIssue(2);
      for (let i = 0; i < 4; i += 1) await tick();
      expect([h.state(1), h.state(2)]).toEqual(["needs-info", "needs-info"]);
      const other = branchHead(2);
      /** ミラーにある、すべての参照。 */
      const mirrorHead = () => plainGit(paths(1).mirrorDir, "for-each-ref");
      const mirror = mirrorHead();

      h.putIssue(1, { labels: ["state:needs-info"], open: false });
      await tick();
      const after = {
        runs: runs(),
        work: fs.readdirSync(path.dirname(paths(1).issueDir)),
      };
      expect(after.work).toEqual(["issue-2"]);

      await tick();
      await tick();

      expect({
        runs: runs(),
        work: fs.readdirSync(path.dirname(paths(1).issueDir)),
      }).toEqual(after);
      expect(branchHead(2)).toBe(other);
      expect(mirror).not.toBe("");
      expect(mirrorHead()).toBe(mirror);
      expect(logged("workspace.removed")).toHaveLength(1);
    });

    it("dry_run の間は、消さない。dry_run でなくなったら消す", async () => {
      h.worker.answer("plan", question);
      h.putIssue(1);
      await tick();
      await tick();
      await supervisor.stop(1000);

      h.dryRun = true;
      supervisor = h.newSupervisor();
      h.putIssue(1, { labels: ["state:needs-info"], open: false });
      await tick();
      await tick();
      expect(exists(1)).toBe(true);

      await supervisor.stop(1000);
      h.dryRun = false;
      supervisor = h.newSupervisor();
      await tick();
      expect(exists(1)).toBe(false);
    });

    // 管理者は、書き込めないディレクトリからも消せるので、失敗を作れない。
    it.skipIf(process.getuid?.() === 0)(
      "消すのに失敗したイシューには、そのポーリングでは着手しない。ほかのイシューは進む",
      async () => {
        await failToLimit();
        const seen = headAtNextPlan();
        const parent = path.dirname(paths(1).issueDir);
        h.putIssue(1, { labels: ["state:ready"] });
        h.putIssue(2);
        fs.chmodSync(parent, 0o555);
        try {
          await tick();
        } finally {
          fs.chmodSync(parent, 0o755);
        }
        expect(exists(1)).toBe(true);
        expect(runs().filter((run) => run.issue_number === 1)).toHaveLength(3);
        expect(
          logged("workspace.sweep_failed").map((line) => line.fields),
        ).toMatchObject([{ repo: REPO, issue: 1 }]);
        expect(h.state(1)).toBe("ready");

        // 次のポーリングで消して、着手する。
        await tick();
        await tick();
        await tick();
        const first = runs().filter((run) => run.issue_number === 1);
        expect(first).toHaveLength(4);
        expect(seen[0]).toBe(plainGit(h.source, "rev-parse", "HEAD"));
      },
    );
  });
});
