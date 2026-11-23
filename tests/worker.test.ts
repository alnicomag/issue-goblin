import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKER_OUTPUT_JSON_SCHEMA,
  WORKER_STATUSES,
  WorkerOutputSchema,
} from "../src/agents/schemas.ts";
import {
  buildClaudeArgv,
  createClaudeWorker,
  interpretRun,
  maskSecrets,
  type WorkerCall,
  type WorkerInvoker,
} from "../src/agents/worker.ts";
import type { WorkerLauncher } from "../src/launcher/client.ts";
import {
  parseRunRequest,
  type RunRequestInput,
  type RunResult,
} from "../src/launcher/request.ts";

const LIMITS = { timeoutSec: 600 };

/** `claude -p --output-format json` の出力に似せたもの。 */
function claudeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "11111111-2222-3333-4444-555555555555",
    total_cost_usd: 0.25,
    num_turns: 3,
    result: '{"status":"done","summary":"終わりました"}',
    structured_output: { status: "done", summary: "終わりました" },
    // 使わない項目は、あっても読み捨てる。
    usage: { input_tokens: 1 },
    ...overrides,
  });
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exit_code: 0,
    timed_out: false,
    stdout: claudeJson(),
    stderr: "",
    truncated: false,
    ...overrides,
  };
}

describe("ワーカーの結果の形式", () => {
  it("--json-schema に渡す形が、zodのスキーマと食い違っていない", () => {
    const generated = z.toJSONSchema(WorkerOutputSchema);
    expect(generated.required).toEqual(WORKER_OUTPUT_JSON_SCHEMA.required);
    expect(generated.additionalProperties).toBe(false);
    expect(Object.keys(generated.properties ?? {})).toEqual(
      Object.keys(WORKER_OUTPUT_JSON_SCHEMA.properties),
    );
    expect(WORKER_OUTPUT_JSON_SCHEMA.properties.status.enum).toEqual([
      ...WORKER_STATUSES,
    ]);
  });
});

describe("interpretRun", () => {
  it.each(WORKER_STATUSES)("状態 %s を、そのまま返す", (status) => {
    const outcome = interpretRun(
      run({
        stdout: claudeJson({
          structured_output: { status, summary: "要約です" },
        }),
      }),
      LIMITS,
    );
    expect(outcome).toEqual({
      status,
      summary: "要約です",
      sessionId: "11111111-2222-3333-4444-555555555555",
      costUsd: 0.25,
      numTurns: 3,
    });
  });

  it("JSONでない出力は、failed になる", () => {
    const outcome = interpretRun(run({ stdout: "作業が終わりました" }), LIMITS);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("JSONとして読めません");
    expect(outcome.summary).toContain("作業が終わりました");
    expect(outcome.sessionId).toBeNull();
    expect(outcome.costUsd).toBeNull();
  });

  it("空の出力は、failed になる", () => {
    const outcome = interpretRun(run({ stdout: "" }), LIMITS);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("JSONとして読めません");
  });

  it("claude の出力として読めないJSONは、failed になる", () => {
    const outcome = interpretRun(run({ stdout: '{"hello":"world"}' }), LIMITS);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("claude の出力の形式が不正です");
    expect(outcome.summary).toContain("type");
  });

  it("必須項目(summary)がない結果は、failed になる", () => {
    const outcome = interpretRun(
      run({ stdout: claudeJson({ structured_output: { status: "done" } }) }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("ワーカーの結果の形式が不正です");
    expect(outcome.summary).toContain("summary");
    // 呼び出しそのものは終わっているので、セッションと金額は返す。
    expect(outcome.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(outcome.costUsd).toBe(0.25);
  });

  it("必須項目(status)がない結果は、failed になる", () => {
    const outcome = interpretRun(
      run({ stdout: claudeJson({ structured_output: { summary: "要約" } }) }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("status");
  });

  it("未知の状態は、failed になる", () => {
    const outcome = interpretRun(
      run({
        stdout: claudeJson({
          structured_output: { status: "rework", summary: "要約" },
        }),
      }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("ワーカーの結果の形式が不正です");
    expect(outcome.summary).toContain("status");
  });

  it("空の要約と、余計な項目は、failed になる", () => {
    for (const structured_output of [
      { status: "done", summary: "  " },
      { status: "done", summary: "要約", extra: 1 },
    ]) {
      const outcome = interpretRun(
        run({ stdout: claudeJson({ structured_output }) }),
        LIMITS,
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.summary).toContain("ワーカーの結果の形式が不正です");
    }
  });

  it("structured_output がなければ、failed になる", () => {
    const outcome = interpretRun(
      run({
        stdout: claudeJson({
          structured_output: undefined,
          result: "できました",
        }),
      }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("structured_output");
    expect(outcome.summary).toContain("できました");
  });

  it("時間切れは、出力があっても failed になる", () => {
    const outcome = interpretRun(
      run({ timed_out: true, exit_code: null, stdout: "" }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("時間の上限(600秒)");

    const withOutput = interpretRun(run({ timed_out: true }), LIMITS);
    expect(withOutput.status).toBe("failed");
  });

  it("ターン数の上限に達した場合は、failed になる", () => {
    const outcome = interpretRun(
      run({
        exit_code: 1,
        stdout: claudeJson({
          subtype: "error_max_turns",
          is_error: true,
          structured_output: undefined,
          result: undefined,
          errors: ["Reached maximum number of turns (1)"],
        }),
      }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("ターン数の上限");
    expect(outcome.summary).toContain("Reached maximum number of turns (1)");
    expect(outcome.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(outcome.costUsd).toBe(0.25);
    expect(outcome.numTurns).toBe(3);
  });

  it("claude が失敗を返した場合は、申告が done でも failed になる", () => {
    const outcome = interpretRun(
      run({
        stdout: claudeJson({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["something went wrong"],
        }),
      }),
      LIMITS,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("error_during_execution");
    expect(outcome.summary).toContain("something went wrong");
  });

  it("終了コードが0でなければ、failed になる", () => {
    const noJson = interpretRun(
      run({ exit_code: 1, stdout: "", stderr: "Invalid API key" }),
      LIMITS,
    );
    expect(noJson.status).toBe("failed");
    expect(noJson.summary).toContain("終了コード 1");
    expect(noJson.summary).toContain("Invalid API key");

    const withJson = interpretRun(run({ exit_code: 2 }), LIMITS);
    expect(withJson.status).toBe("failed");
    expect(withJson.summary).toContain("終了コード 2");

    const killed = interpretRun(run({ exit_code: null, stdout: "" }), LIMITS);
    expect(killed.status).toBe("failed");
    expect(killed.summary).toContain("終了コード null");
  });

  it("出力が途中で切られた場合は、failed になる", () => {
    const outcome = interpretRun(run({ truncated: true }), LIMITS);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("途中で切られました");
  });

  it("要約と失敗の理由に、トークンに見える文字列を残さない", () => {
    const secret = "sk-ant-oat01-EXAMPLE_value-123";
    const done = interpretRun(
      run({
        stdout: claudeJson({
          structured_output: { status: "done", summary: `値は ${secret}` },
        }),
      }),
      LIMITS,
    );
    expect(done.summary).toBe("値は sk-ant-***");

    const failed = interpretRun(
      run({ exit_code: 1, stdout: "", stderr: `token ${secret} rejected` }),
      LIMITS,
    );
    expect(failed.summary).not.toContain(secret);
  });

  it("長い標準エラーは、末尾だけを理由に載せる", () => {
    const outcome = interpretRun(
      run({ exit_code: 1, stdout: "", stderr: `${"x".repeat(10_000)}END` }),
      LIMITS,
    );
    expect(outcome.summary.length).toBeLessThan(2200);
    expect(outcome.summary.endsWith("END")).toBe(true);
  });
});

describe("maskSecrets", () => {
  it("トークンに見える文字列だけを伏せる", () => {
    expect(maskSecrets("a sk-ant-api03-abc_DEF-1 b sk-ant-oat01-x")).toBe(
      "a sk-ant-*** b sk-ant-***",
    );
    expect(maskSecrets("普通の文章")).toBe("普通の文章");
  });
});

describe("buildClaudeArgv", () => {
  const argv = buildClaudeArgv({ maxTurns: 40 });
  const flagValue = (flag: string) => argv[argv.indexOf(flag) + 1];

  it("ヘッドレスで、決まった形式の結果を求める", () => {
    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(flagValue("--output-format")).toBe("json");
    expect(JSON.parse(flagValue("--json-schema") ?? "")).toEqual(
      WORKER_OUTPUT_JSON_SCHEMA,
    );
    expect(flagValue("--max-turns")).toBe("40");
  });

  it("読み込む設定の範囲を明示する(プロジェクト設定だけ、MCPなし)", () => {
    expect(flagValue("--setting-sources")).toBe("project");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--bare");
  });

  it("GitHubに書き込む道具を拒否する", () => {
    const denied = flagValue("--disallowedTools") ?? "";
    expect(denied).toContain("Bash(gh *)");
    expect(denied).toContain("Bash(git push *)");
  });
});

describe("createClaudeWorker", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const CALL: WorkerCall = {
    repo: "owner/name",
    issue: 12,
    step: "plan",
    prompt: "plan",
    values: { issue: "イシューの本文" },
    timeoutSec: 600,
    maxTurns: 40,
  };

  function setup(
    onRun: (request: RunRequestInput) => RunResult | Promise<RunResult> = () =>
      run(),
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-test-"));
    dirs.push(root);
    const promptsDir = path.join(root, "prompts");
    const logsDir = path.join(root, "logs");
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(
      path.join(promptsDir, "plan.md"),
      "計画を書くこと。\n\n{{issue}}\n",
    );
    const requests: RunRequestInput[] = [];
    const launcher: WorkerLauncher = {
      async run(request) {
        requests.push(request);
        return onRun(request);
      },
    };
    const worker = createClaudeWorker({
      launcher,
      promptsDir,
      logsDir,
      clock: { now: () => new Date("2026-01-02T03:04:05.678Z") },
    });
    return { worker, requests, logsDir, promptsDir };
  }

  it("偽の実装に差し替えられる", async () => {
    const fake: WorkerInvoker = {
      invoke: async () => ({
        status: "question",
        summary: "どちらにしますか",
        sessionId: null,
        costUsd: null,
        numTurns: null,
        logPath: "/nonexistent/log",
      }),
    };
    expect((await fake.invoke(CALL)).status).toBe("question");
  });

  it("指示書をファイルから読み、値を差し込んで標準入力で渡す", async () => {
    const { worker, requests } = setup();
    const result = await worker.invoke(CALL);
    expect(result.status).toBe("done");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.stdin).toBe("計画を書くこと。\n\nイシューの本文\n");
    expect(requests[0]?.argv).toEqual(buildClaudeArgv({ maxTurns: 40 }));
    expect(requests[0]?.timeout_sec).toBe(600);
  });

  it("依頼は起動係の検査に通り、環境変数やトークンの値を含まない", async () => {
    const { worker, requests } = setup();
    await worker.invoke(CALL);
    const request = requests[0];
    // 起動係の依頼は、ここにある項目だけを受け付ける(環境変数の項目はない)。
    expect(Object.keys(request ?? {}).sort()).toEqual([
      "argv",
      "claude_token",
      "issue",
      "repo",
      "stdin",
      "timeout_sec",
    ]);
    expect(request?.claude_token).toBe(true);
    expect(parseRunRequest(request).ok).toBe(true);
  });

  it("セッション、金額、ログの場所を返し、ログをファイルに残す", async () => {
    const { worker, logsDir } = setup(() => run({ stderr: "warning: x" }));
    const result = await worker.invoke(CALL);
    expect(result).toEqual({
      status: "done",
      summary: "終わりました",
      sessionId: "11111111-2222-3333-4444-555555555555",
      costUsd: 0.25,
      numTurns: 3,
      logPath: path.join(
        logsDir,
        "owner/name/issue-12/20260102T030405.678Z-plan.log",
      ),
    });
    const log = fs.readFileSync(result.logPath, "utf8");
    expect(log).toContain('"status": "done"');
    expect(log).toContain('"exit_code": 0');
    expect(log).toContain("--- stdout ---");
    expect(log).toContain('"structured_output"');
    expect(log).toContain("warning: x");
    // 指示書と入力は、ログに写さない。
    expect(log).not.toContain("イシューの本文");
    expect(fs.statSync(result.logPath).mode & 0o777).toBe(0o600);
  });

  it("同じ時刻の呼び出しでも、ログを上書きしない", async () => {
    const { worker } = setup();
    const first = await worker.invoke(CALL);
    const second = await worker.invoke(CALL);
    expect(second.logPath).not.toBe(first.logPath);
    expect(second.logPath.endsWith("-plan-2.log")).toBe(true);
    expect(fs.existsSync(first.logPath)).toBe(true);
  });

  it("ログに、トークンに見える文字列を残さない", async () => {
    const secret = "sk-ant-oat01-EXAMPLE_value-123";
    const { worker } = setup(() =>
      run({
        stdout: claudeJson({ result: `env: ${secret}` }),
        stderr: `debug ${secret}`,
      }),
    );
    const result = await worker.invoke(CALL);
    const log = fs.readFileSync(result.logPath, "utf8");
    expect(log).not.toContain(secret);
    expect(log).toContain("sk-ant-***");
  });

  it("時間切れは failed になり、ログが残る", async () => {
    const { worker } = setup(() =>
      run({ timed_out: true, exit_code: null, stdout: "" }),
    );
    const result = await worker.invoke(CALL);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("時間の上限(600秒)");
    expect(fs.readFileSync(result.logPath, "utf8")).toContain(
      '"timed_out": true',
    );
  });

  it("形式に合わない出力は failed になり、出力がログに残る", async () => {
    const { worker } = setup(() => run({ stdout: "not json" }));
    const result = await worker.invoke(CALL);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("JSONとして読めません");
    expect(fs.readFileSync(result.logPath, "utf8")).toContain("not json");
  });

  it("起動係に断られた場合は、理由つきの failed になる", async () => {
    const { worker } = setup(() => {
      throw new Error("起動係が依頼を拒否しました: 設定にないリポジトリです");
    });
    const result = await worker.invoke(CALL);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("ワーカーを起動できませんでした");
    expect(result.summary).toContain("設定にないリポジトリです");
    expect(fs.existsSync(result.logPath)).toBe(true);
  });

  it("指示書がなければ、起動係を呼ばずに失敗する", async () => {
    const { worker, requests } = setup();
    await expect(worker.invoke({ ...CALL, prompt: "review" })).rejects.toThrow(
      "指示書を読めません",
    );
    expect(requests).toHaveLength(0);
  });

  it("差し込む値が欠けていれば、起動係を呼ばずに失敗する", async () => {
    const { worker, requests } = setup();
    await expect(worker.invoke({ ...CALL, values: {} })).rejects.toThrow(
      "指示書に差し込む値が欠けています: issue",
    );
    await expect(
      worker.invoke({ ...CALL, values: { issue: "本文", isue: "本文" } }),
    ).rejects.toThrow("指示書にない名前の値が渡されました: isue");
    expect(requests).toHaveLength(0);
  });

  it("不正な呼び出しは、起動係を呼ばずに失敗する", async () => {
    const { worker, requests } = setup();
    for (const [bad, pattern] of [
      [{ maxTurns: 0 }, /maxTurns/],
      [{ timeoutSec: 0 }, /timeoutSec/],
      [{ timeoutSec: 999_999 }, /timeoutSec/],
      [{ step: "../x" }, /step/],
      [{ issue: 1.5 }, /issue/],
      [{ repo: "../.." }, /作業場所/],
    ] as const) {
      await expect(worker.invoke({ ...CALL, ...bad })).rejects.toThrow(pattern);
    }
    expect(requests).toHaveLength(0);
  });
});
