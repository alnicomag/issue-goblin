import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerLauncher } from "../src/launcher/client.ts";
import {
  parseRunRequest,
  type RunRequestInput,
  type RunResult,
} from "../src/launcher/request.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { parseFactoryYml } from "../src/office/product.ts";
import {
  buildVerifyArgv,
  judgeVerify,
  runVerify,
  shouldRun,
  type VerifyCommandResult,
  type VerifyDeps,
} from "../src/office/verify.ts";
import { VALID_FACTORY_YML } from "./fake-github.ts";

const REPO = "owner/name";
const ISSUE = 7;
const INPUT = { repo: REPO, issue: ISSUE, timeoutSec: 60 };

function ok(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exit_code: 0,
    timed_out: false,
    stdout: "",
    stderr: "",
    truncated: false,
    ...overrides,
  };
}

/** 依頼を記録し、コマンド(`sh -c` の中身)ごとに決めた結果を返す、偽の起動係。 */
class FakeLauncher implements WorkerLauncher {
  readonly requests: RunRequestInput[] = [];
  readonly answers = new Map<string, RunResult | Error>();

  run(request: RunRequestInput): Promise<RunResult> {
    this.requests.push(request);
    const answer = this.answers.get(request.argv[2] ?? "") ?? ok();
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }

  get commands(): string[] {
    return this.requests.map((request) => request.argv[2] ?? "");
  }
}

/** 呼ぶたびに1.5秒進む時計。 */
function steppingClock() {
  let now = Date.parse("2026-03-01T01:00:00.000Z");
  return {
    now: () => {
      const current = new Date(now);
      now += 1500;
      return current;
    },
  };
}

describe("検査コマンドの実行(verify)", () => {
  let tmp: string;
  let db: Db;
  let launcher: FakeLauncher;
  let deps: VerifyDeps;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
    db = openDb(":memory:");
    migrate(db, { clock: steppingClock() });
    const parsed = parseFactoryYml(VALID_FACTORY_YML);
    if (!parsed.ok) throw new Error(parsed.errors);
    db.prepare(
      "INSERT INTO repos (repo, factory_yml, factory_yml_sha) VALUES (?, ?, ?)",
    ).run(REPO, JSON.stringify(parsed.value), "sha-1");
    launcher = new FakeLauncher();
    deps = {
      db,
      launcher,
      dirs: {
        reposDir: path.join(tmp, "repos"),
        workDir: path.join(tmp, "work"),
      },
      logsDir: path.join(tmp, "logs"),
      clock: steppingClock(),
    };
    fs.mkdirSync(
      path.join(tmp, "work", "owner", "name", "issue-7", "repo", ".git"),
      { recursive: true },
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("すべてのコマンドが終了コード0なら、合格になる", async () => {
    const result = await runVerify(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "done",
      passed: true,
      failedCommands: [],
    });
    expect(launcher.commands).toEqual([
      "example-setup",
      "example-test",
      "example-lint",
    ]);
    expect(result.commands.map((command) => command.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
  });

  it("終了コード、所要時間、ログの場所を記録する", async () => {
    launcher.answers.set(
      "example-test",
      ok({ exit_code: 3, stdout: "1 failed", stderr: "boom" }),
    );
    const result = await runVerify(deps, INPUT);
    expect(result.commands[1]).toEqual({
      name: "test",
      command: "example-test",
      status: "failed",
      exitCode: 3,
      durationMs: 1500,
      truncated: false,
      outputTail: "1 failed\nboom",
    });
    expect(result.logPath).toBe(
      path.join(
        tmp,
        "logs",
        "owner",
        "name",
        "issue-7",
        "20260301T010000.000Z-verify.log",
      ),
    );
    const log = fs.readFileSync(result.logPath, "utf8");
    expect(log).toContain('"exit_code": 3');
    expect(log).toContain('"duration_ms": 1500');
    expect(log).toContain("--- test stdout ---\n1 failed");
    expect(log).toContain("--- test stderr ---\nboom");
  });

  it.each([
    ["test", ["test"], ["passed", "failed", "passed"]],
    ["lint", ["lint"], ["passed", "passed", "failed"]],
  ] as const)(
    "%s が0以外で終わると不合格になり、失敗したコマンドとログの場所が結果に含まれる",
    async (name, failed, statuses) => {
      launcher.answers.set(`example-${name}`, ok({ exit_code: 1 }));
      const result = await runVerify(deps, INPUT);
      expect(result).toMatchObject({
        outcome: "rework",
        passed: false,
        failedCommands: failed,
      });
      expect(result.summary).toContain(`${name}(終了コード 1)`);
      expect(result.commands.map((command) => command.status)).toEqual(
        statuses,
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
    },
  );

  it("test と lint の両方が失敗すれば、両方が結果に含まれる", async () => {
    launcher.answers.set("example-test", ok({ exit_code: 1 }));
    launcher.answers.set("example-lint", ok({ exit_code: 2 }));
    const result = await runVerify(deps, INPUT);
    expect(result.failedCommands).toEqual(["test", "lint"]);
  });

  it("setup が失敗したら、残りは実行せず、不合格になる", async () => {
    launcher.answers.set("example-setup", ok({ exit_code: 127 }));
    const result = await runVerify(deps, INPUT);
    expect(launcher.commands).toEqual(["example-setup"]);
    expect(result).toMatchObject({
      outcome: "rework",
      failedCommands: ["setup"],
    });
    expect(result.summary).toContain("実行しなかったもの: test、lint");
    expect(result.commands.map((command) => command.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
  });

  it("時間切れのコマンドは、不合格として扱う", async () => {
    launcher.answers.set(
      "example-test",
      ok({ exit_code: null, timed_out: true }),
    );
    const result = await runVerify(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "rework",
      passed: false,
      failedCommands: ["test"],
    });
    expect(result.commands[1]?.status).toBe("timed_out");
    expect(result.summary).toContain("test(時間の上限 60秒");
  });

  it("時間切れは、終了コードが0でも不合格にする", async () => {
    launcher.answers.set("example-lint", ok({ timed_out: true }));
    expect((await runVerify(deps, INPUT)).passed).toBe(false);
  });

  it("シグナルで終わったコマンド(終了コードなし)は、不合格にする", async () => {
    launcher.answers.set("example-lint", ok({ exit_code: null }));
    expect((await runVerify(deps, INPUT)).failedCommands).toEqual(["lint"]);
  });

  it("依頼は起動係が受け付ける形で、時間の上限を付け、Claudeのトークンを求めない", async () => {
    await runVerify(deps, INPUT);
    expect(launcher.requests).toHaveLength(3);
    for (const request of launcher.requests) {
      expect(parseRunRequest(request).ok).toBe(true);
      expect(request).toEqual({
        repo: REPO,
        issue: ISSUE,
        argv: ["sh", "-c", expect.any(String)],
        claude_token: false,
        timeout_sec: 60,
      });
    }
  });

  it("事務局の環境変数は、依頼にも、コマンドにも、ログにも入らない", async () => {
    const name = "VERIFY_TEST_OFFICE_SECRET";
    process.env[name] = "office-secret-value";
    try {
      const result = await runVerify(deps, INPUT);
      const sent = JSON.stringify(launcher.requests);
      expect(sent).not.toContain("office-secret-value");
      expect(sent).not.toContain(name);
      expect(fs.readFileSync(result.logPath, "utf8")).not.toContain(
        "office-secret-value",
      );
    } finally {
      delete process.env[name];
    }
  });

  it("コマンドは、作業場所のファイルではなく、保存済みの factory.yml から読む", async () => {
    fs.writeFileSync(
      path.join(tmp, "work", "owner", "name", "issue-7", "repo", "factory.yml"),
      VALID_FACTORY_YML.replaceAll("example-", "rewritten-"),
    );
    await runVerify(deps, INPUT);
    expect(launcher.commands).toEqual([
      "example-setup",
      "example-test",
      "example-lint",
    ]);
  });

  it("出力にトークンが混ざっていても、ログと結果には残らない", async () => {
    launcher.answers.set(
      "example-test",
      ok({
        exit_code: 1,
        stdout: "token sk-ant-oat01-abcDEF_123",
        stderr: "again sk-ant-api03-zzz",
      }),
    );
    const result = await runVerify(deps, INPUT);
    const log = fs.readFileSync(result.logPath, "utf8");
    expect(log).toContain("token sk-ant-***");
    expect(log).not.toMatch(/sk-ant-(oat|api)/);
    expect(JSON.stringify(result)).not.toMatch(/sk-ant-(oat|api)/);
  });

  it("起動係に届かなければ、差し戻しではなく失敗になり、残りは実行しない", async () => {
    launcher.answers.set("example-test", new Error("起動係に届きません"));
    const result = await runVerify(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "failed",
      passed: false,
      failedCommands: [],
    });
    expect(result.summary).toContain("test を実行できませんでした");
    expect(result.summary).toContain("起動係に届きません");
    expect(launcher.commands).toEqual(["example-setup", "example-test"]);
    expect(fs.existsSync(result.logPath)).toBe(true);
  });

  it("factory.yml が不正なら、実行せずに原因の分かるメッセージで失敗する", async () => {
    db.prepare(
      "UPDATE repos SET factory_yml = NULL, factory_yml_sha = 'sha-bad'",
    ).run();
    await expect(runVerify(deps, INPUT)).rejects.toThrow(
      /owner\/name の factory\.yml が不正/,
    );
    expect(launcher.requests).toHaveLength(0);
  });

  it("factory.yml が未取得なら、実行せずに失敗する", async () => {
    db.prepare(
      "UPDATE repos SET factory_yml = NULL, factory_yml_sha = NULL",
    ).run();
    await expect(runVerify(deps, INPUT)).rejects.toThrow(
      /factory\.yml は未取得/,
    );
    expect(launcher.requests).toHaveLength(0);
  });

  it("同期していないリポジトリでは、実行せずに失敗する", async () => {
    db.prepare("DELETE FROM repos").run();
    await expect(runVerify(deps, INPUT)).rejects.toThrow(/owner\/name.*未取得/);
    expect(launcher.requests).toHaveLength(0);
  });

  it("作業場所のcloneがなければ、実行せずに失敗する", async () => {
    await expect(runVerify(deps, { ...INPUT, issue: 8 })).rejects.toThrow(
      /イシュー 8 の作業場所が未取得/,
    );
    expect(launcher.requests).toHaveLength(0);
  });

  it("作業場所がリンクに差し替えられていたら、たどらずに失敗する", async () => {
    const issueDir = path.join(tmp, "work", "owner", "name", "issue-7");
    fs.renameSync(path.join(issueDir, "repo"), path.join(issueDir, "moved"));
    fs.symlinkSync(path.join(issueDir, "moved"), path.join(issueDir, "repo"));
    await expect(runVerify(deps, INPUT)).rejects.toThrow(/作業場所が未取得/);
    expect(launcher.requests).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 4 * 60 * 60 + 1, Number.NaN])(
    "時間の上限が範囲の外(%s)なら、実行せずに失敗する",
    async (timeoutSec) => {
      await expect(runVerify(deps, { ...INPUT, timeoutSec })).rejects.toThrow(
        /時間の上限が不正/,
      );
      expect(launcher.requests).toHaveLength(0);
    },
  );

  it("2回実行しても、ログは別のファイルになる", async () => {
    const fixed = { now: () => new Date("2026-03-01T01:00:00.000Z") };
    const first = await runVerify({ ...deps, clock: fixed }, INPUT);
    const second = await runVerify({ ...deps, clock: fixed }, INPUT);
    expect(second.logPath).not.toBe(first.logPath);
    expect(fs.existsSync(first.logPath)).toBe(true);
    expect(fs.existsSync(second.logPath)).toBe(true);
  });
});

describe("検査コマンドの判定(純粋関数)", () => {
  const result = (
    name: VerifyCommandResult["name"],
    status: VerifyCommandResult["status"],
  ): VerifyCommandResult => ({
    name,
    command: `example-${name}`,
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    durationMs: 10,
    truncated: false,
    outputTail: "",
  });

  it("コマンドは sh -c で実行する", () => {
    expect(buildVerifyArgv("example-test --flag")).toEqual([
      "sh",
      "-c",
      "example-test --flag",
    ]);
  });

  it("setup が通らなければ先へ進まず、test が通らなくても lint へ進む", () => {
    expect(shouldRun([])).toBe(true);
    expect(shouldRun([result("setup", "passed")])).toBe(true);
    expect(shouldRun([result("setup", "failed")])).toBe(false);
    expect(shouldRun([result("setup", "timed_out")])).toBe(false);
    expect(
      shouldRun([result("setup", "passed"), result("test", "failed")]),
    ).toBe(true);
    expect(
      shouldRun([result("setup", "passed"), result("test", "timed_out")]),
    ).toBe(true);
    expect(
      shouldRun([result("setup", "passed"), result("test", "not_run")]),
    ).toBe(false);
  });

  it("全部通れば done、失敗があれば rework、実行できなければ failed", () => {
    const passed = (["setup", "test", "lint"] as const).map((name) =>
      result(name, "passed"),
    );
    expect(judgeVerify(passed, 60).outcome).toBe("done");
    expect(
      judgeVerify([...passed.slice(0, 2), result("lint", "failed")], 60)
        .outcome,
    ).toBe("rework");
    expect(
      judgeVerify([...passed.slice(0, 2), result("lint", "timed_out")], 60)
        .outcome,
    ).toBe("rework");
    expect(
      judgeVerify(
        [
          result("setup", "passed"),
          result("test", "failed"),
          result("lint", "not_run"),
        ],
        60,
      ).outcome,
    ).toBe("failed");
  });
});
