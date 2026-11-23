import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LauncherAbortedError,
  type WorkerLauncher,
} from "../src/launcher/client.ts";
import {
  parseRunRequest,
  type RunRequestInput,
  type RunResult,
} from "../src/launcher/request.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { parseFactoryYml } from "../src/office/product.ts";
import { feedbackFor } from "../src/office/runner.ts";
import type { Step } from "../src/office/runs.ts";
import {
  buildVerifyArgv,
  interpretStatus,
  judgeVerify,
  MAX_UNCOMMITTED_PATHS,
  parseStatusPaths,
  runVerify,
  STATUS_ARGV,
  shouldRun,
  type VerifyCommandResult,
  type VerifyDeps,
} from "../src/office/verify.ts";
import { VALID_FACTORY_YML } from "./fake-github.ts";
import { commitFile, makeRepo, plainGit } from "./git-fixtures.ts";

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

/**
 * 依頼を記録し、コマンド(`sh -c` の中身)ごとに決めた結果を返す、偽の起動係。
 * 作業場所の状態の確認(`git status`)には、`status` を返す。既定は「きれい」。
 */
class FakeLauncher implements WorkerLauncher {
  readonly requests: RunRequestInput[] = [];
  readonly answers = new Map<string, RunResult | Error>();
  status: RunResult | Error = ok();

  run(request: RunRequestInput): Promise<RunResult> {
    this.requests.push(request);
    const answer =
      request.argv[0] === "git"
        ? this.status
        : (this.answers.get(request.argv[2] ?? "") ?? ok());
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }

  /** 実行した検査コマンド(状態の確認は含まない)。 */
  get commands(): string[] {
    return this.requests
      .filter((request) => request.argv[0] === "sh")
      .map((request) => request.argv[2] ?? "");
  }
}

/**
 * 状態の確認(`git`)だけを、手元の仮のリポジトリで実際に実行する起動係。
 * コンテナの中での実行の代わりで、検査コマンドには成功を返す。
 */
class GitRunningLauncher extends FakeLauncher {
  private readonly repoDir: string;

  constructor(repoDir: string) {
    super();
    this.repoDir = repoDir;
  }

  override run(request: RunRequestInput): Promise<RunResult> {
    if (request.argv[0] === "git") {
      this.status = ok({
        stdout: execFileSync("git", request.argv.slice(1), {
          cwd: this.repoDir,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        }),
      });
    }
    return super.run(request);
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
    expect(launcher.requests).toHaveLength(4);
    for (const request of launcher.requests) {
      expect(parseRunRequest(request).ok).toBe(true);
      expect(request).toEqual({
        repo: REPO,
        issue: ISSUE,
        argv:
          request.argv[0] === "git"
            ? [...STATUS_ARGV]
            : ["sh", "-c", expect.any(String)],
        claude_token: false,
        timeout_sec: 60,
      });
    }
  });

  it("最初に、作業場所の状態を、起動係を通して確かめる", async () => {
    await runVerify(deps, INPUT);
    expect(launcher.requests[0]?.argv).toEqual([...STATUS_ARGV]);
    expect(launcher.requests[0]?.argv[0]).toBe("git");
  });

  it("状態の確認の時間の上限は、検査コマンドの上限を超えない", async () => {
    await runVerify(deps, { ...INPUT, timeoutSec: 3600 });
    expect(launcher.requests[0]?.timeout_sec).toBe(300);
    expect(launcher.requests[1]?.timeout_sec).toBe(3600);
  });

  it("コミットされていないパスが残っていれば、コマンドを実行せずに差し戻す", async () => {
    launcher.status = ok({ stdout: " M src/a.txt\0?? new file.txt\0" });
    const result = await runVerify(deps, INPUT);
    expect(launcher.commands).toEqual([]);
    expect(result).toMatchObject({
      outcome: "rework",
      passed: false,
      failedCommands: [],
      uncommittedPaths: ["src/a.txt", "new file.txt"],
      uncommittedCount: 2,
    });
    expect(result.summary).toContain("2件");
    expect(result.commands.map((command) => command.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
    const log = fs.readFileSync(result.logPath, "utf8");
    expect(log).toContain('"outcome": "rework"');
    expect(log).toContain(" M src/a.txt\n?? new file.txt");
  });

  it("残っているパスが多いときは、先頭だけを結果に載せ、件数を残す", async () => {
    const count = MAX_UNCOMMITTED_PATHS + 5;
    launcher.status = ok({
      stdout: Array.from({ length: count }, (_, i) => `?? f${i}.txt\0`).join(
        "",
      ),
    });
    const result = await runVerify(deps, INPUT);
    expect(result.uncommittedPaths).toHaveLength(MAX_UNCOMMITTED_PATHS);
    expect(result.uncommittedCount).toBe(count);
  });

  it("残っているパスにトークンに見える文字列があっても、結果には残らない", async () => {
    launcher.status = ok({ stdout: "?? sk-ant-oat01-abcDEF_123.txt\0" });
    const result = await runVerify(deps, INPUT);
    expect(result.uncommittedPaths).toEqual(["sk-ant-***.txt"]);
    expect(fs.readFileSync(result.logPath, "utf8")).not.toMatch(/sk-ant-oat/);
  });

  it.each([
    ["0以外で終わった", ok({ exit_code: 128, stderr: "not a git repository" })],
    ["時間切れになった", ok({ exit_code: null, timed_out: true })],
    ["起動係に届かない", new Error("起動係に届きません")],
  ] as const)(
    "状態の確認が%s場合は、差し戻しではなく失敗になり、コマンドは実行しない",
    async (_name, status) => {
      launcher.status = status;
      const result = await runVerify(deps, INPUT);
      expect(result).toMatchObject({
        outcome: "failed",
        passed: false,
        failedCommands: [],
        uncommittedPaths: [],
      });
      expect(result.summary).toContain("作業場所の状態を確かめられません");
      expect(launcher.commands).toEqual([]);
      expect(fs.existsSync(result.logPath)).toBe(true);
    },
  );

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

  describe("中断", () => {
    it("検査コマンドの途中で中断すると、実行できなかった場合とは別に、中断として残る", async () => {
      launcher.answers.set("example-test", new LauncherAbortedError());
      const result = await runVerify(deps, INPUT);
      expect(result).toMatchObject({
        interrupted: true,
        passed: false,
        failedCommands: [],
      });
      expect(result.summary).toContain("中断しました");
      expect(result.summary).not.toContain("実行できませんでした");
      expect(result.commands.map((command) => command.status)).toEqual([
        "passed",
        "interrupted",
        "skipped",
      ]);
      expect(launcher.commands).toEqual(["example-setup", "example-test"]);

      const log = fs.readFileSync(result.logPath, "utf8");
      expect(log).toContain('"outcome": "interrupted"');
      expect(log).toContain('"status": "interrupted"');
      expect(log).not.toContain("実行できませんでした");
      expect(log).not.toContain("not_run");
    });

    it("状態の確認の途中で中断すると、確かめられなかった場合とは別に、中断として残る", async () => {
      launcher.status = new LauncherAbortedError();
      const result = await runVerify(deps, INPUT);
      expect(result).toMatchObject({
        interrupted: true,
        passed: false,
        uncommittedPaths: [],
      });
      expect(result.summary).toContain("中断しました");
      expect(result.summary).not.toContain("確かめられません");
      expect(result.commands.map((command) => command.status)).toEqual([
        "skipped",
        "skipped",
        "skipped",
      ]);
      expect(launcher.commands).toEqual([]);

      const log = fs.readFileSync(result.logPath, "utf8");
      expect(log).toContain('"outcome": "interrupted"');
      expect(log).not.toContain("確かめられません");
      expect(log).not.toContain('"status": "unknown"');
    });

    it("起動係に届かない場合と、依頼を拒否された場合は、中断にならない", async () => {
      launcher.answers.set(
        "example-test",
        new Error("起動係が依頼を拒否しました: 設定にないリポジトリです"),
      );
      const refused = await runVerify(deps, INPUT);
      expect(refused.interrupted).toBe(false);
      expect(refused.outcome).toBe("failed");
      expect(refused.summary).toContain("test を実行できませんでした");
      expect(refused.commands.map((command) => command.status)).toEqual([
        "passed",
        "not_run",
        "skipped",
      ]);
      const refusedLog = fs.readFileSync(refused.logPath, "utf8");
      expect(refusedLog).toContain('"outcome": "failed"');
      expect(refusedLog).not.toContain("interrupted");

      launcher.status = new Error("起動係に届きません");
      const unreachable = await runVerify(deps, INPUT);
      expect(unreachable.interrupted).toBe(false);
      expect(unreachable.outcome).toBe("failed");
      expect(unreachable.summary).toContain("作業場所の状態を確かめられません");
      const unreachableLog = fs.readFileSync(unreachable.logPath, "utf8");
      expect(unreachableLog).toContain('"status": "unknown"');
      expect(unreachableLog).not.toContain("interrupted");
    });

    it("合格した検査は、中断ではない", async () => {
      expect((await runVerify(deps, INPUT)).interrupted).toBe(false);
    });

    it("中断のログと結果に、トークンに見える文字列を残さない", async () => {
      launcher.answers.set(
        "example-setup",
        ok({ stdout: "token sk-ant-oat01-abcDEF_123" }),
      );
      launcher.answers.set(
        "example-test",
        new LauncherAbortedError({
          cause: new Error("socket hang up sk-ant-api03-zzz"),
        }),
      );
      const result = await runVerify(deps, INPUT);
      expect(result.interrupted).toBe(true);
      const log = fs.readFileSync(result.logPath, "utf8");
      expect(log).toContain("token sk-ant-***");
      expect(log).not.toMatch(/sk-ant-(oat|api)/);
      expect(JSON.stringify(result)).not.toMatch(/sk-ant-(oat|api)/);
    });
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

describe("コミットされていない内容が残った作業場所での verify", () => {
  let tmp: string;
  let db: Db;
  let repoDir: string;
  let launcher: GitRunningLauncher;
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
    repoDir = makeRepo(
      path.join(tmp, "work", "owner", "name", "issue-7", "repo"),
      "agent/issue-7",
    );
    commitFile(repoDir, ".gitignore", "deps/\n");
    launcher = new GitRunningLauncher(repoDir);
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
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** verify の結果を、実行する側と同じ形でチェックポイントにして、implement への指摘を作る。 */
  function feedbackOf(result: Awaited<ReturnType<typeof runVerify>>): string {
    const step = {
      name: "verify",
      status: result.outcome,
      output: JSON.stringify({
        summary: result.summary,
        passed: result.passed,
        failedCommands: result.failedCommands,
        commands: result.commands,
        uncommittedPaths: result.uncommittedPaths,
        uncommittedCount: result.uncommittedCount,
      }),
    } as Step;
    return feedbackFor([step]);
  }

  it("きれいな作業場所では、これまでどおりコマンドを実行して合格になる", async () => {
    const result = await runVerify(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "done",
      passed: true,
      uncommittedPaths: [],
      uncommittedCount: 0,
    });
    expect(launcher.commands).toEqual([
      "example-setup",
      "example-test",
      "example-lint",
    ]);
  });

  it("コミットしていない変更が残っていれば、コマンドを1つも実行せずに差し戻し、パスを指摘に含める", async () => {
    fs.writeFileSync(path.join(repoDir, "README.txt"), "changed\n");
    const result = await runVerify(deps, INPUT);
    expect(result.outcome).toBe("rework");
    expect(launcher.commands).toEqual([]);
    expect(result.uncommittedPaths).toEqual(["README.txt"]);
    expect(feedbackOf(result)).toContain("- README.txt");
  });

  it("ステージしただけの変更も、残っているものとして扱う", async () => {
    fs.writeFileSync(path.join(repoDir, "staged.txt"), "staged\n");
    plainGit(repoDir, "add", "--", "staged.txt");
    const result = await runVerify(deps, INPUT);
    expect(result.outcome).toBe("rework");
    expect(result.uncommittedPaths).toEqual(["staged.txt"]);
  });

  it("追跡していないファイルが残っていれば、コマンドを1つも実行せずに差し戻し、パスを指摘に含める", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "helper.txt"), "forgotten\n");
    const result = await runVerify(deps, INPUT);
    expect(result.outcome).toBe("rework");
    expect(launcher.commands).toEqual([]);
    expect(result.uncommittedPaths).toEqual(["src/helper.txt"]);
    expect(feedbackOf(result)).toContain("- src/helper.txt");
  });

  it("改名してコミットしていない場合は、消したパスと足したパスの両方を挙げる", async () => {
    plainGit(repoDir, "mv", "README.txt", "RENAMED.txt");
    const result = await runVerify(deps, INPUT);
    expect([...result.uncommittedPaths].sort()).toEqual([
      "README.txt",
      "RENAMED.txt",
    ]);
  });

  it("無視対象のファイルが残っていても、止めない", async () => {
    fs.mkdirSync(path.join(repoDir, "deps", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "deps", "pkg", "index.txt"), "dep\n");
    const result = await runVerify(deps, INPUT);
    expect(result).toMatchObject({ outcome: "done", uncommittedPaths: [] });
    expect(launcher.commands).toHaveLength(3);
  });

  it("状態の確認は、作業場所を書き換えない", async () => {
    fs.writeFileSync(path.join(repoDir, "left.txt"), "left\n");
    const before = plainGit(repoDir, "rev-parse", "HEAD");
    await runVerify(deps, INPUT);
    expect(plainGit(repoDir, "rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(repoDir, "left.txt"), "utf8")).toBe(
      "left\n",
    );
  });
});

describe("作業場所の状態の読み取り(純粋関数)", () => {
  it("NUL区切りの出力から、パスを取り出す", () => {
    expect(parseStatusPaths("")).toEqual([]);
    expect(parseStatusPaths(" M a.txt\0?? dir/b c.txt\0D  gone.txt\0")).toEqual(
      ["a.txt", "dir/b c.txt", "gone.txt"],
    );
  });

  it("想定外の形の項目は、捨てずにそのまま残す", () => {
    expect(parseStatusPaths("xy\0")).toEqual(["xy"]);
  });

  it("出力がなければきれい、あれば残っている、実行できなければ確認できない", () => {
    expect(interpretStatus(ok())).toEqual({ status: "clean" });
    expect(interpretStatus(ok({ stdout: "?? a\0" }))).toEqual({
      status: "dirty",
      paths: ["a"],
    });
    expect(interpretStatus(ok({ exit_code: 128, stderr: "boom" }))).toEqual({
      status: "unknown",
      reason: expect.stringContaining("boom"),
    });
    expect(interpretStatus(ok({ exit_code: 0, timed_out: true })).status).toBe(
      "unknown",
    );
    expect(interpretStatus(ok({ exit_code: null })).status).toBe("unknown");
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
