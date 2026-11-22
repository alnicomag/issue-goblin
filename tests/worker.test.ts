import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKER_OUTPUT_JSON_SCHEMA,
  WORKER_STATUSES,
  WorkerOutputSchema,
} from "../src/agents/schemas.ts";
import { interpretRun, maskSecrets } from "../src/agents/worker.ts";
import type { RunResult } from "../src/launcher/request.ts";

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
