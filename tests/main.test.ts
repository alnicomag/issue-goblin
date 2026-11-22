import { describe, expect, it } from "vitest";
import { type LogFields, silentLogger } from "../src/office/log.ts";
import { createApis, runLoop } from "../src/office/main.ts";

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

describe("起動時のトークンの確認", () => {
  const config = {
    dry_run: true,
    poll_interval_sec: 60,
    db_path: ":memory:",
    worker_image: "factory-worker",
    retry_wait_minutes: [5, 30, 120],
    repos: [
      { repo: "owner/first", token_env: "TOKEN_FIRST" },
      { repo: "owner/second", token_env: "TOKEN_SECOND" },
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
