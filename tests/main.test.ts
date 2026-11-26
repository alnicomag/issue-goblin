import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/office/config.ts";
import { type LogFields, silentLogger } from "../src/office/log.ts";
import {
  createApis,
  pollOnce,
  resolveOwners,
  runLoop,
} from "../src/office/main.ts";
import { findResumableRuns } from "../src/office/runs.ts";
import { createHarness, REPO } from "./factory-harness.ts";
import { FakeGitHub } from "./fake-github.ts";

describe("メインループ", () => {
  it("止められるまで、間隔をあけて繰り返す", async () => {
    const controller = new AbortController();
    let polls = 0;
    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      logger: silentLogger,
      poll: async () => {
        polls += 1;
        if (polls === 3) controller.abort();
      },
    });
    expect(polls).toBe(3);
  });

  it("止める合図が来ても、実行中のポーリングは最後まで終える", async () => {
    const controller = new AbortController();
    const steps: string[] = [];
    await runLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      logger: silentLogger,
      poll: async () => {
        steps.push("start");
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        steps.push("end");
      },
    });
    expect(steps).toEqual(["start", "end"]);
  });

  it("待機中に止められたら、間隔を待たずに戻る", async () => {
    const controller = new AbortController();
    const started = Date.now();
    await runLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      logger: silentLogger,
      poll: async () => {
        setTimeout(() => controller.abort(), 5);
      },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("ポーリングが失敗しても、ログに出して続ける", async () => {
    const controller = new AbortController();
    const errors: LogFields[] = [];
    let polls = 0;
    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      logger: {
        ...silentLogger,
        error: (_event, fields = {}) => errors.push(fields),
      },
      poll: async () => {
        polls += 1;
        if (polls === 1) throw new Error("first poll failed");
        controller.abort();
      },
    });
    expect(polls).toBe(2);
    expect(errors).toMatchObject([{ error: "first poll failed" }]);
  });
});

describe("1回のポーリング", () => {
  it("同期の後に、同期できたリポジトリだけの実行を扱う", async () => {
    const h = createHarness();
    try {
      const broken = new FakeGitHub();
      broken.failWith = new Error("boom");
      const ticks: (readonly string[])[] = [];
      const pendingFull = new Set(["owner/broken", REPO]);
      h.putIssue(1);
      await pollOnce({
        sync: {
          db: h.db,
          apiFor: (repo) => (repo === REPO ? h.fake : broken),
          dryRun: false,
          clock: h.clock,
          logger: h.logger,
          locks: h.locks,
        },
        supervisor: {
          tick: async (repos) => {
            // 同期が先に済んでいる。
            expect(h.state(1)).toBe("ready");
            ticks.push(repos);
          },
        },
        repos: ["owner/broken", REPO],
        pendingFull,
      });
      expect(ticks).toEqual([[REPO]]);
      expect([...pendingFull]).toEqual(["owner/broken"]);
    } finally {
      h.cleanup();
    }
  });

  it("止める合図で、実行中のステップを待たずに終わり、起動し直すと続きから進む", async () => {
    const h = createHarness();
    try {
      const poll = (supervisor: ReturnType<typeof h.newSupervisor>) => () =>
        pollOnce({
          sync: {
            db: h.db,
            apiFor: () => h.fake,
            dryRun: false,
            clock: h.clock,
            logger: h.logger,
            locks: h.locks,
          },
          supervisor,
          repos: [REPO],
          pendingFull: new Set(),
        });

      // SIGTERMに当たる合図を、implement の途中で出す。
      const controller = new AbortController();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.worker.scripts.set("implement", async () => {
        controller.abort();
        await held;
        return undefined;
      });
      h.putIssue(1);
      const first = h.newSupervisor();
      await runLoop({
        poll: poll(first),
        intervalMs: 5,
        signal: controller.signal,
        logger: h.logger,
      });
      // ステップは終わっていないが、待たずに止まる。
      expect(await first.stop(20)).toBe(false);
      release();
      await first.idle();
      expect(findResumableRuns(h.db)).toMatchObject([
        { step: "implement", interrupted: true, run: { attempt: 1 } },
      ]);

      // 起動し直す。
      h.worker.scripts.delete("implement");
      const second = h.newSupervisor();
      await poll(second)();
      await second.idle();
      await poll(second)();
      expect(h.labels(1)).toEqual(["state:in-review"]);
      expect(h.fake.pullRequests).toHaveLength(1);
      expect(h.worker.callsOf("plan")).toHaveLength(1);
      expect(h.db.prepare("SELECT attempt, status FROM runs").all()).toEqual([
        { attempt: 1, status: "running" },
      ]);
      await second.stop(1000);
    } finally {
      h.cleanup();
    }
  });
});

describe("起動時のトークンの確認", () => {
  const config = {
    dry_run: true,
    poll_interval_sec: 60,
    db_path: ":memory:",
    repos_dir: "/data/repos",
    work_dir: "/work",
    logs_dir: "/data/logs",
    worker_image: "factory-worker",
    retry_wait_minutes: [5, 30, 120],
    daily_run_limit: 20,
    commit_author: { name: "Example", email: "example@example.invalid" },
    step_limits: {
      plan: { timeout_sec: 1800, max_turns: 50 },
      implement: { timeout_sec: 7200, max_turns: 200 },
      review: { timeout_sec: 1800, max_turns: 50 },
      verify: { timeout_sec: 1800 },
    },
    repos: [
      { repo: "owner/first", token_env: "TOKEN_FIRST", assigned_only: false },
      {
        repo: "owner/second",
        token_env: "TOKEN_SECOND",
        assigned_only: false,
      },
    ],
  };

  it("リポジトリごとに通信の口を作る", () => {
    const apis = createApis(
      config,
      { TOKEN_FIRST: "dummy-1", TOKEN_SECOND: "dummy-2" },
      silentLogger,
    );
    expect([...apis.keys()]).toEqual(["owner/first", "owner/second"]);
  });

  it("環境変数がなければ、変数名の分かるメッセージで失敗する", () => {
    expect(() =>
      createApis(config, { TOKEN_FIRST: "dummy-1" }, silentLogger),
    ).toThrow(/TOKEN_SECOND/);
  });
});

describe("トークンの持ち主の読み取り", () => {
  const config = (flags: string) =>
    parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_EXAMPLE
${flags}
  - repo: owner/other
    token_env: GITHUB_TOKEN_OTHER
`);

  it("assigned_only のリポジトリだけ、GitHubから読む", async () => {
    const asked: string[] = [];
    const owners = await resolveOwners(
      config("    assigned_only: true"),
      (repo) => ({
        getAuthenticatedLogin: async () => {
          asked.push(repo);
          return "example-login";
        },
      }),
    );
    expect([...owners]).toEqual([["owner/name", "example-login"]]);
    expect(asked).toEqual(["owner/name"]);
  });

  it("無効(既定)なら、読まない", async () => {
    const owners = await resolveOwners(config(""), () => {
      throw new Error("読まないはず");
    });
    expect(owners.size).toBe(0);
  });

  it("読めなければ、リポジトリと環境変数の名前の分かるメッセージで失敗する", async () => {
    await expect(
      resolveOwners(config("    assigned_only: true"), () => ({
        getAuthenticatedLogin: () => Promise.reject(new Error("401")),
      })),
    ).rejects.toThrow(/owner\/name.*GITHUB_TOKEN_EXAMPLE/);
  });
});
