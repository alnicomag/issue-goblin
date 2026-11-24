import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeWorker } from "../src/agents/worker.ts";
import {
  LauncherAbortedError,
  type WorkerLauncher,
} from "../src/launcher/client.ts";
import { FACTORY_MARKER } from "../src/office/github.ts";
import {
  advanceRun,
  feedbackFor,
  formatIssue,
  formatVerify,
  lastDoneSummary,
} from "../src/office/runner.ts";
import { getRun, listSteps, startRun } from "../src/office/runs.ts";
import { workspacePaths } from "../src/office/workspace.ts";
import { createHarness, type Harness, REPO } from "./factory-harness.ts";
import { plainGit } from "./git-fixtures.ts";

const ISSUE = 7;

describe("ステップの実行", () => {
  let h: Harness;

  beforeEach(async () => {
    h = createHarness();
    h.putIssue(ISSUE, { labels: ["state:in-progress"], body: "the body" });
    await h.sync();
  });

  afterEach(() => h.cleanup());

  const start = () =>
    startRun(h.db, h.clock, { repo: REPO, issueNumber: ISSUE }).id;
  const advance = (runId: number, signal = new AbortController().signal) =>
    advanceRun(h.runner, runId, signal);
  const stepsOf = (runId: number) =>
    listSteps(h.db, runId).map((step) => `${step.name}:${step.status}`);
  const outputOf = (runId: number, name: string) => {
    const step = listSteps(h.db, runId).findLast((s) => s.name === name);
    return JSON.parse(step?.output ?? "null") as Record<string, unknown>;
  };
  const close = async () => {
    h.putIssue(ISSUE, { labels: ["state:in-review"], open: false });
    await h.sync();
  };

  it("prepare から publish まで進み、クローズを待つ", async () => {
    const runId = start();
    expect(await advance(runId)).toEqual({ kind: "waiting_close" });
    expect(stepsOf(runId)).toEqual([
      "prepare:done",
      "plan:done",
      "implement:done",
      "verify:done",
      "review:done",
      "publish:done",
    ]);
    expect(getRun(h.db, runId).status).toBe("running");
    expect(h.launcher.commands).toEqual([
      "example-setup",
      "example-test",
      "example-lint",
    ]);

    // PRが1つでき、ブランチが取得元に届いている。
    expect(h.fake.pullRequests).toHaveLength(1);
    expect(h.fake.pullRequests[0]).toMatchObject({
      head: `agent/issue-${ISSUE}`,
      base: "main",
    });
    expect(h.fake.pullRequests[0]?.body).toContain(FACTORY_MARKER);
    const pushed = plainGit(h.source, "rev-parse", `agent/issue-${ISSUE}`);
    expect(outputOf(runId, "publish")).toMatchObject({
      status: "published",
      prNumber: 100,
      headCommit: pushed,
    });
    expect(outputOf(runId, "implement").headCommit).toBe(pushed);
    const row = h.db
      .prepare("SELECT branch, pr_number, worktree_path FROM runs WHERE id = ?")
      .get(runId);
    expect(row).toEqual({
      branch: `agent/issue-${ISSUE}`,
      pr_number: 100,
      worktree_path: workspacePaths(h.dirs, REPO, ISSUE).issueDir,
    });
  });

  it("状態(ラベル)は変えない", async () => {
    await advance(start());
    expect(h.labels(ISSUE)).toEqual(["state:in-progress"]);
    expect(h.fake.writes.map((call) => call.method)).toEqual([
      "createPullRequest",
    ]);
  });

  it("クローズを待つ間は、何度呼んでも進まない。クローズされたら cleanup して終わる", async () => {
    const runId = start();
    await advance(runId);
    expect(await advance(runId)).toEqual({ kind: "waiting_close" });
    const { issueDir } = workspacePaths(h.dirs, REPO, ISSUE);
    expect(fs.existsSync(issueDir)).toBe(true);

    await close();
    expect(await advance(runId)).toEqual({ kind: "finished", status: "done" });
    expect(stepsOf(runId).at(-1)).toBe("cleanup:done");
    expect(getRun(h.db, runId).status).toBe("done");
    expect(fs.existsSync(issueDir)).toBe(false);
    // 終わった実行は、もう進まない。
    expect(await advance(runId)).toEqual({ kind: "finished", status: "done" });
  });

  it("ワーカーには、イシューの本文、人間のコメント、保存済みの factory.yml を渡す", async () => {
    h.fake.putComment({
      id: 10,
      issueNumber: ISSUE,
      author: "alice",
      body: "a human comment",
      updatedAt: "2026-03-01T00:30:00.000Z",
    });
    h.fake.putComment({
      id: 11,
      issueNumber: ISSUE,
      body: `from the factory\n${FACTORY_MARKER}`,
      updatedAt: "2026-03-01T00:31:00.000Z",
    });
    await h.sync();
    h.worker.answer("plan", { status: "done", summary: "THE PLAN" });
    await advance(start());

    const [plan] = h.worker.callsOf("plan");
    expect(plan?.values.issue).toContain(`Issue ${ISSUE}`);
    expect(plan?.values.issue).toContain("the body");
    expect(plan?.values.issue).toContain("a human comment");
    expect(plan?.values.issue).not.toContain("from the factory");
    expect(plan?.values.factory_yml).toContain("example-test");

    const [implement] = h.worker.callsOf("implement");
    expect(implement?.values).toMatchObject({ plan: "THE PLAN", feedback: "" });

    const [review] = h.worker.callsOf("review");
    expect(review?.values.diff).toContain(`feature-${ISSUE}-1.txt`);
    expect(review?.values.test_result).toContain("- test: passed");
  });

  it("ワーカーが質問を返したら、質問で終わる", async () => {
    h.worker.answer("plan", { status: "question", summary: "どちらですか" });
    const runId = start();
    expect(await advance(runId)).toEqual({
      kind: "finished",
      status: "question",
    });
    expect(stepsOf(runId)).toEqual(["prepare:done", "plan:question"]);
    expect(getRun(h.db, runId).status).toBe("question");
    expect(h.fake.writes).toEqual([]);
  });

  it("verify が通らなければ implement に戻し、出力の末尾を指摘として渡す", async () => {
    h.launcher.answer("example-test", { exit_code: 1, stdout: "TEST BROKE" });
    const runId = start();
    expect(await advance(runId)).toEqual({ kind: "waiting_close" });
    expect(stepsOf(runId)).toEqual([
      "prepare:done",
      "plan:done",
      "implement:done",
      "verify:rework",
      "implement:done",
      "verify:done",
      "review:done",
      "publish:done",
    ]);
    const second = h.worker.callsOf("implement")[1];
    expect(second?.values.feedback).toContain("TEST BROKE");
    expect(second?.values.feedback).toContain("test");
  });

  it("review の修正要求も implement に戻す。3回目の差し戻しで失敗する", async () => {
    const rework = { status: "rework", summary: "FIX THIS" } as const;
    h.worker.answer("review", rework, rework, rework);
    const runId = start();
    expect(await advance(runId)).toEqual({
      kind: "finished",
      status: "failed",
    });
    expect(h.worker.callsOf("implement")).toHaveLength(3);
    expect(h.worker.callsOf("implement")[1]?.values.feedback).toBe("FIX THIS");
    const run = getRun(h.db, runId);
    expect(run.status).toBe("failed");
    expect(run.nextRetryAt).not.toBeNull();
    expect(h.fake.pullRequests).toEqual([]);
  });

  describe("PRの本文に載せる要約", () => {
    const prBody = () => h.fake.pullRequests[0]?.body ?? "";

    it("implement と review の要約を、PRの本文に載せる", async () => {
      const runId = start();
      expect(await advance(runId)).toEqual({ kind: "waiting_close" });
      expect(h.fake.pullRequests).toHaveLength(1);
      expect(prBody()).toContain(
        "## 実装の要約(ワーカーの申告)\n\nimplement の結果\n",
      );
      expect(prBody()).toContain(
        "## レビューの結果(ワーカーの申告)\n\nreview の結果\n",
      );
      // plan の要約は載せない。
      expect(prBody()).not.toContain("plan の結果");
    });

    it("差し戻しがあった実行では、最後の implement と review の要約を載せる", async () => {
      let implemented = 0;
      h.worker.scripts.set("implement", (call) => {
        implemented += 1;
        h.worker.commit(call.repo, call.issue);
        return { status: "done", summary: `IMPLEMENT ROUND ${implemented}` };
      });
      h.worker.answer(
        "review",
        { status: "rework", summary: "REVIEW ROUND 1: FIX THIS" },
        { status: "done", summary: "REVIEW ROUND 2: PASSED" },
      );
      const runId = start();
      expect(await advance(runId)).toEqual({ kind: "waiting_close" });
      expect(stepsOf(runId)).toEqual([
        "prepare:done",
        "plan:done",
        "implement:done",
        "verify:done",
        "review:rework",
        "implement:done",
        "verify:done",
        "review:done",
        "publish:done",
      ]);
      expect(h.fake.pullRequests).toHaveLength(1);
      expect(prBody()).toContain("IMPLEMENT ROUND 2");
      expect(prBody()).toContain("REVIEW ROUND 2: PASSED");
      expect(prBody()).not.toContain("IMPLEMENT ROUND 1");
      expect(prBody()).not.toContain("REVIEW ROUND 1");
    });

    it("lastDoneSummary は、done で終わった最後のステップの要約を返す。なければ null", async () => {
      h.worker.answer(
        "review",
        { status: "rework", summary: "FIX" },
        { status: "done", summary: "PASSED" },
      );
      const runId = start();
      await advance(runId);
      const steps = listSteps(h.db, runId);
      expect(lastDoneSummary(steps, "review")).toBe("PASSED");
      expect(lastDoneSummary(steps, "implement")).toBe("implement の結果");
      expect(
        lastDoneSummary(
          steps.filter((step) => step.status !== "done"),
          "review",
        ),
      ).toBeNull();
      expect(lastDoneSummary([], "implement")).toBeNull();
    });
  });

  it("ステップの中の例外は、そのステップの失敗として記録する", async () => {
    h.db.prepare("UPDATE repos SET factory_yml = NULL").run();
    const runId = start();
    expect(await advance(runId)).toEqual({
      kind: "finished",
      status: "failed",
    });
    expect(stepsOf(runId)).toEqual(["prepare:done", "plan:failed"]);
    expect(String(outputOf(runId, "plan").summary)).toContain("factory.yml");
    expect(
      h.logs.filter((line) => line.event === "run.step_error"),
    ).toHaveLength(1);
  });

  it("コミットがなければ、publish で止まって失敗する", async () => {
    h.worker.answer("implement", { status: "done", summary: "did nothing" });
    const runId = start();
    expect(await advance(runId)).toEqual({
      kind: "finished",
      status: "failed",
    });
    expect(stepsOf(runId).at(-1)).toBe("publish:failed");
    expect(outputOf(runId, "publish").status).toBe("no_commits");
    expect(h.fake.writes).toEqual([]);
  });

  it.each([
    {
      file: "docs/guide.md",
      status: "needs_approval",
      hits: { protected: [{ path: "docs/guide.md", pattern: "docs/**" }] },
    },
    {
      file: "generated/out.txt",
      status: "forbidden",
      hits: {
        forbidden: [{ path: "generated/out.txt", pattern: "generated/**" }],
      },
    },
  ])(
    "$status で止まると、実行は held で終わり、当たったパスが記録に残る",
    async ({ file, status, hits }) => {
      let head = "";
      h.worker.scripts.set("implement", (call) => {
        head = h.worker.commitPath(call.repo, call.issue, file);
        return { status: "done", summary: "touched a guarded path" };
      });
      const runId = start();
      expect(await advance(runId)).toEqual({
        kind: "finished",
        status: "held",
      });
      expect(stepsOf(runId).at(-1)).toBe("publish:held");
      expect(outputOf(runId, "publish")).toMatchObject({
        status,
        headCommit: head,
        forbidden: [],
        protected: [],
        ...hits,
      });
      // 承認待ちのときだけ、保護対象のパスの差分が記録に残る。
      const recorded = outputOf(runId, "publish").protectedDiff as {
        text: string;
      } | null;
      if (status === "needs_approval") {
        expect(recorded?.text).toContain(`+++ b/${file}`);
      } else {
        expect(recorded).toBeNull();
      }
      expect(getRun(h.db, runId)).toMatchObject({
        status: "held",
        nextRetryAt: null,
      });
      expect(h.fake.writes).toEqual([]);
    },
  );

  it("dry_run なら、publish は書き込まずに終わる", async () => {
    h.dryRun = true;
    const runId = start();
    expect(await advance(runId)).toEqual({ kind: "waiting_close" });
    expect(outputOf(runId, "publish").status).toBe("dry_run");
    expect(h.fake.writes).toEqual([]);
  });

  it("止められたら、何も記録せずに戻る。実行中のステップは残る", async () => {
    const controller = new AbortController();
    h.worker.scripts.set("implement", () => {
      controller.abort();
      return undefined;
    });
    const runId = start();
    expect(await advance(runId, controller.signal)).toEqual({
      kind: "aborted",
    });
    expect(stepsOf(runId)).toEqual([
      "prepare:done",
      "plan:done",
      "implement:running",
    ]);
    expect(getRun(h.db, runId).status).toBe("running");
  });

  describe("再開", () => {
    const STEPS = [
      "prepare",
      "plan",
      "implement",
      "verify",
      "review",
      "publish",
    ];

    for (const stopAt of STEPS) {
      it(`${stopAt} の途中で止めて作り直すと、そのステップから続き、PRは1つのまま`, async () => {
        const controller = new AbortController();
        h.onLog = (line) => {
          if (
            line.event === "run.step_started" &&
            line.fields.step === stopAt
          ) {
            controller.abort();
          }
        };
        const runId = start();
        expect(await advance(runId, controller.signal)).toEqual({
          kind: "aborted",
        });
        expect(stepsOf(runId).at(-1)).toBe(`${stopAt}:running`);
        const attempt = getRun(h.db, runId).attempt;

        // 事務局を起動し直した後。
        h.onLog = () => {};
        expect(await advance(runId)).toEqual({ kind: "waiting_close" });
        expect(stepsOf(runId)).toEqual(STEPS.map((name) => `${name}:done`));
        expect(h.fake.pullRequests).toHaveLength(1);
        expect(
          h.fake.writes.filter((call) => call.method === "createPullRequest"),
        ).toHaveLength(1);
        expect(getRun(h.db, runId).attempt).toBe(attempt);
        // 終わったステップは、やり直していない。
        const before = STEPS.slice(0, STEPS.indexOf(stopAt));
        for (const prompt of ["plan", "implement", "review"]) {
          const expected = before.includes(prompt) || prompt !== stopAt ? 1 : 2;
          expect(h.worker.callsOf(prompt), prompt).toHaveLength(expected);
        }
      });
    }

    it("ワーカーの呼び出しを中断すると、再開したステップから、中断した呼び出しのログを辿れる", async () => {
      const controller = new AbortController();
      // 本物の呼び出しと、事務局の停止で依頼が中断される起動係。
      const launcher: WorkerLauncher = {
        run(request, options) {
          if (request.argv[0] !== "claude") return h.launcher.run(request);
          controller.abort();
          expect(options?.signal?.aborted).toBe(true);
          return Promise.reject(new LauncherAbortedError());
        },
      };
      const runId = start();
      expect(
        await advanceRun(
          {
            ...h.runner,
            launcher,
            createWorker: (stoppable) =>
              createClaudeWorker({
                launcher: stoppable,
                promptsDir: path.resolve("prompts"),
                logsDir: h.runner.logsDir,
                clock: h.clock,
              }),
          },
          runId,
          controller.signal,
        ),
      ).toEqual({ kind: "aborted" });

      // 結果は記録せず、ログの場所だけを残す。
      const stopped = listSteps(h.db, runId).at(-1);
      expect(stopped).toMatchObject({
        name: "plan",
        status: "running",
        output: null,
        finishedAt: null,
      });
      const interrupted = stopped?.interruptedLogPaths ?? [];
      expect(interrupted).toHaveLength(1);
      const log = fs.readFileSync(interrupted[0] ?? "", "utf8");
      expect(log).toContain('"status": "interrupted"');
      expect(log).not.toContain("起動できませんでした");

      // 事務局を起動し直した後。
      expect(await advance(runId)).toEqual({ kind: "waiting_close" });
      const plan = listSteps(h.db, runId).find((step) => step.name === "plan");
      expect(plan?.status).toBe("done");
      expect(plan?.interruptedLogPaths).toEqual(interrupted);
      const row = h.db
        .prepare(
          "SELECT log_path FROM steps WHERE run_id = ? AND name = 'plan'",
        )
        .get(runId) as { log_path: string };
      expect(row.log_path).toBe("/nonexistent/plan-1.log");
      expect(row.log_path).not.toBe(interrupted[0]);
    });

    it("検査コマンドを中断すると、再開した verify から、中断した検査のログを辿れる", async () => {
      const controller = new AbortController();
      // 事務局の停止で、検査コマンドの依頼が中断される起動係。
      const launcher: WorkerLauncher = {
        run(request, options) {
          if (request.argv[2] !== "example-test") {
            return h.launcher.run(request);
          }
          controller.abort();
          expect(options?.signal?.aborted).toBe(true);
          return Promise.reject(new LauncherAbortedError());
        },
      };
      const runId = start();
      expect(
        await advanceRun({ ...h.runner, launcher }, runId, controller.signal),
      ).toEqual({ kind: "aborted" });

      // 結果は記録せず、ログの場所だけを残す。
      const stopped = listSteps(h.db, runId).at(-1);
      expect(stopped).toMatchObject({
        name: "verify",
        status: "running",
        output: null,
        finishedAt: null,
      });
      const interrupted = stopped?.interruptedLogPaths ?? [];
      expect(interrupted).toHaveLength(1);
      const log = fs.readFileSync(interrupted[0] ?? "", "utf8");
      expect(log).toContain('"outcome": "interrupted"');
      expect(log).not.toContain("実行できませんでした");

      // 事務局を起動し直した後。
      expect(await advance(runId)).toEqual({ kind: "waiting_close" });
      const row = h.db
        .prepare(
          "SELECT status, log_path, interrupted_log_paths FROM steps WHERE run_id = ? AND name = 'verify'",
        )
        .get(runId) as {
        status: string;
        log_path: string;
        interrupted_log_paths: string;
      };
      expect(row.status).toBe("done");
      expect(JSON.parse(row.interrupted_log_paths)).toEqual(interrupted);
      expect(row.log_path).not.toBe(interrupted[0]);
      expect(fs.readFileSync(row.log_path, "utf8")).toContain(
        '"outcome": "done"',
      );
    });

    it("中断でない結果は、止められた後に返ってきても、中断のログとして残さない", async () => {
      const controller = new AbortController();
      h.worker.scripts.set("plan", () => {
        controller.abort();
        return undefined;
      });
      const runId = start();
      expect(await advance(runId, controller.signal)).toEqual({
        kind: "aborted",
      });
      expect(listSteps(h.db, runId).at(-1)).toMatchObject({
        name: "plan",
        status: "running",
        interruptedLogPaths: [],
      });
    });

    it("implement の途中の状態が残った作業場所で再開すると、作業場所には手を付けずに、同じ指示書でやり直す", async () => {
      const { repoDir } = workspacePaths(h.dirs, REPO, ISSUE);
      // コミットしていない変更と、追跡していないファイルの一覧。
      const status = () => ({
        modified: plainGit(repoDir, "diff", "--name-only", "HEAD"),
        untracked: plainGit(
          repoDir,
          "ls-files",
          "--others",
          "--exclude-standard",
        ),
      });
      const controller = new AbortController();
      let committed = "";
      // 1回目のワーカーは、コミットを1つ作り、書きかけを残したところで止められる。
      h.worker.scripts.set("implement", (call) => {
        if (h.worker.callsOf("implement").length > 1) return undefined;
        committed = h.worker.commit(call.repo, call.issue);
        fs.writeFileSync(`${repoDir}/README.txt`, "half-written change\n");
        fs.writeFileSync(`${repoDir}/untracked.txt`, "half-written file\n");
        controller.abort();
        // 止めた後の結果は、記録されない。
        return { status: "done", summary: "中断された呼び出しの結果" };
      });
      const runId = start();
      expect(await advance(runId, controller.signal)).toEqual({
        kind: "aborted",
      });
      expect(stepsOf(runId).at(-1)).toBe("implement:running");
      const leftover = status();
      expect(leftover).toEqual({
        modified: "README.txt",
        untracked: "untracked.txt",
      });

      // 事務局を起動し直した後。再開したワーカーが呼ばれた時点で、途中の状態はそのまま残っている。
      let seenOnResume: unknown;
      h.worker.scripts.set("implement", () => {
        seenOnResume = {
          status: status(),
          head: plainGit(repoDir, "rev-parse", "HEAD"),
        };
        return undefined;
      });
      expect(await advance(runId)).toEqual({ kind: "waiting_close" });
      expect(seenOnResume).toEqual({ status: leftover, head: committed });

      // 再開の呼び出しは、中断していない呼び出しと同じ内容である。
      const [first, second] = h.worker.callsOf("implement");
      expect(second).toEqual(first);
      expect(second?.values.feedback).toBe("");

      // 事務局は最後まで作業場所を片付けない。コミット済みの内容は残り、PRに入る。
      expect(status()).toEqual(leftover);
      expect(fs.readFileSync(`${repoDir}/untracked.txt`, "utf8")).toBe(
        "half-written file\n",
      );
      expect(
        plainGit(repoDir, "merge-base", "--is-ancestor", committed, "HEAD"),
      ).toBe("");
      expect(stepsOf(runId)).toEqual(STEPS.map((name) => `${name}:done`));
      expect(h.fake.pullRequests).toHaveLength(1);
      // コミットしていない変更は、PRに入らない。
      const pushed = plainGit(h.source, "rev-parse", `agent/issue-${ISSUE}`);
      expect(pushed).toBe(plainGit(repoDir, "rev-parse", "HEAD"));
      expect(plainGit(h.source, "show", `${pushed}:README.txt`)).toBe(
        "example",
      );
    });

    it("cleanup の途中で止めて作り直しても、終わる", async () => {
      const runId = start();
      await advance(runId);
      await close();
      const controller = new AbortController();
      h.onLog = (line) => {
        if (line.event === "run.step_started") controller.abort();
      };
      expect(await advance(runId, controller.signal)).toEqual({
        kind: "aborted",
      });
      h.onLog = () => {};
      expect(await advance(runId)).toEqual({
        kind: "finished",
        status: "done",
      });
    });
  });
});

describe("指示書に差し込む文章", () => {
  it("イシューは、タイトル、本文、コメントの順に並べる", () => {
    const text = formatIssue({
      number: 3,
      title: "Title",
      body: "Body\n",
      comments: [
        {
          author: "alice",
          body: "first",
          commentedAt: "2026-03-01T00:00:00.000Z",
        },
        { author: null, body: "second", commentedAt: null },
      ],
    });
    expect(text).toBe(
      [
        "# Title(#3)",
        "",
        "Body",
        "",
        "## コメント 1(alice、2026-03-01T00:00:00.000Z)",
        "",
        "first",
        "",
        "## コメント 2(不明)",
        "",
        "second",
        "",
      ].join("\n"),
    );
  });

  it("本文が空なら、空であることを書く", () => {
    expect(
      formatIssue({ number: 1, title: "T", body: null, comments: [] }),
    ).toContain("(本文なし)");
  });

  it("検査の結果は、コマンドごとの状態と、出力の末尾を書く", () => {
    const text = formatVerify({
      passed: false,
      summary: "検査コマンドが失敗しました",
      commands: [
        { name: "setup", status: "passed", exitCode: 0, outputTail: "" },
        { name: "test", status: "failed", exitCode: 1, outputTail: "boom" },
      ],
    });
    expect(text).toContain("- setup: passed(終了コード: 0)");
    expect(text).toContain("- test: failed(終了コード: 1)");
    expect(text).toContain("### test の出力の末尾");
    expect(text).toContain("boom");
    expect(formatVerify(null)).toContain("記録がありません");
  });

  it("差し戻しがなければ、指摘は空", () => {
    expect(feedbackFor([])).toBe("");
  });
});
