import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_MARKER } from "../src/office/github.ts";
import {
  findResumableRuns,
  listSteps,
  nextAttempt,
  startRun,
} from "../src/office/runs.ts";
import {
  questionComment,
  questionMarker,
  type Supervisor,
} from "../src/office/supervisor.ts";
import { createHarness, type Harness, REPO } from "./factory-harness.ts";
import { VALID_FACTORY_YML } from "./fake-github.ts";

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
});
