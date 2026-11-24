import fs from "node:fs";
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
import { createGit } from "../src/office/git.ts";
import type { LogFields, Logger } from "../src/office/log.ts";
import {
  createPreflightGate,
  decidePreflight,
  FAILED_RECHECK_MINUTES,
  IMAGE_BUILD_COMMAND,
  type PreflightDeps,
  type PreflightRecord,
  readPreflight,
  runPreflight,
  savePreflight,
} from "../src/office/preflight.ts";
import { parseFactoryYml } from "../src/office/product.ts";
import { ImageBuildError } from "../src/office/product-image.ts";
import {
  preflightWorkspacePaths,
  prepareWorkspace,
  type WorkspaceDirs,
} from "../src/office/workspace.ts";
import { VALID_FACTORY_YML } from "./fake-github.ts";
import { commitFile, makeRepo, makeTempDir } from "./git-fixtures.ts";

const REPO = "owner/name";
const IMAGE = "example-image";
const SHA = "sha-1";
const AUTHOR = { name: "Example Worker", email: "worker@example.invalid" };
/** トークンに見える文字列。伏せられることを確かめるために使う。 */
const SECRET = "sk-ant-dummy_value-123";

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

function record(overrides: Partial<PreflightRecord> = {}): PreflightRecord {
  return {
    repo: REPO,
    status: "passed",
    image: IMAGE,
    factoryYmlSha: SHA,
    dockerfileSha: null,
    command: "example-setup",
    exitCode: 0,
    timedOut: false,
    outputTail: "",
    logPath: "/logs/a.log",
    checkedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("確かめるかどうかの決め方", () => {
  const at = (minutes: number) =>
    new Date(Date.parse("2026-03-01T00:00:00.000Z") + minutes * 60_000);
  const decide = (
    stored: PreflightRecord | null,
    overrides: {
      image?: string;
      sha?: string | null;
      dockerfileSha?: string | null;
      now?: Date;
    } = {},
  ) =>
    decidePreflight({
      record: stored,
      image: overrides.image ?? IMAGE,
      factoryYmlSha: overrides.sha === undefined ? SHA : overrides.sha,
      dockerfileSha: overrides.dockerfileSha ?? null,
      now: overrides.now ?? at(1),
    });

  it("記録がなければ、確かめる", () => {
    expect(decide(null)).toBe("check");
  });

  it("通った記録は、条件が同じ間は、どれだけたっても確かめ直さない", () => {
    expect(decide(record())).toBe("passed");
    expect(decide(record(), { now: at(60 * 24 * 365) })).toBe("passed");
  });

  it("イメージの名前か factory.yml の sha が変わったら、通っていても通らなくても確かめる", () => {
    for (const status of ["passed", "failed"] as const) {
      expect(decide(record({ status }), { image: "other-image" })).toBe(
        "check",
      );
      expect(decide(record({ status }), { sha: "sha-2" })).toBe("check");
    }
  });

  it("製品の Dockerfile の sha が変わったら、通っていても通らなくても確かめる", () => {
    for (const status of ["passed", "failed"] as const) {
      // Dockerfile が足された、変わった、なくなった。
      expect(decide(record({ status }), { dockerfileSha: "d-1" })).toBe(
        "check",
      );
      expect(
        decide(record({ status, dockerfileSha: "d-1" }), {
          dockerfileSha: "d-2",
        }),
      ).toBe("check");
      expect(decide(record({ status, dockerfileSha: "d-1" }))).toBe("check");
    }
    // 同じなら、確かめ直さない。
    expect(
      decide(record({ dockerfileSha: "d-1" }), { dockerfileSha: "d-1" }),
    ).toBe("passed");
  });

  it("通らなかった記録は、条件が同じなら、決まった時間がたつまで確かめ直さない", () => {
    const failed = record({ status: "failed", exitCode: 127 });
    expect(decide(failed, { now: at(0) })).toBe("failed");
    expect(decide(failed, { now: at(FAILED_RECHECK_MINUTES - 1) })).toBe(
      "failed",
    );
    expect(decide(failed, { now: at(FAILED_RECHECK_MINUTES) })).toBe("check");
    expect(decide(failed, { now: at(FAILED_RECHECK_MINUTES + 1) })).toBe(
      "check",
    );
  });

  it("factory.yml の sha が分からないか、記録の時刻を読めなければ、確かめる", () => {
    expect(decide(record(), { sha: null })).toBe("check");
    expect(decide(record({ status: "failed", checkedAt: "いつか" }))).toBe(
      "check",
    );
  });
});

/** 依頼を記録し、決めた結果を順に返す、偽の起動係。尽きたら、成功を返す。 */
class FakeLauncher implements WorkerLauncher {
  readonly requests: RunRequestInput[] = [];
  readonly answers: (RunResult | Error | (() => Promise<RunResult>))[] = [];
  /** 依頼を受けたときに、作業場所で行うこと。 */
  onRun: (request: RunRequestInput) => void = () => {};

  async run(
    request: RunRequestInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunResult> {
    this.requests.push(request);
    this.onRun(request);
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") {
      // 止められたら、本物と同じ例外で戻る。
      return await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          const abort = () => reject(new LauncherAbortedError());
          if (options.signal?.aborted === true) abort();
          options.signal?.addEventListener("abort", abort);
        }),
      ]);
    }
    return next ?? ok();
  }
}

describe("着手前の確認", () => {
  let tmp: string;
  let db: Db;
  let source: string;
  let dirs: WorkspaceDirs;
  let logsDir: string;
  let launcher: FakeLauncher;
  let clock: { time: string; now(): Date };
  let logs: { level: string; event: string; fields: LogFields }[];
  let logger: Logger;
  let deps: PreflightDeps;

  const setFactoryYml = (sha: string | null, content: string | null) => {
    const parsed = content === null ? null : parseFactoryYml(content);
    if (parsed !== null && !parsed.ok) throw new Error(parsed.errors);
    db.prepare(
      `INSERT INTO repos (repo, factory_yml, factory_yml_sha) VALUES (?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET
         factory_yml = excluded.factory_yml, factory_yml_sha = excluded.factory_yml_sha`,
    ).run(REPO, parsed === null ? null : JSON.stringify(parsed.value), sha);
  };
  const run = (signal?: AbortSignal) =>
    runPreflight(deps, {
      repo: REPO,
      image: IMAGE,
      timeoutSec: 600,
      ...(signal === undefined ? {} : { signal }),
    });
  const preflightDir = () => preflightWorkspacePaths(dirs, REPO).issueDir;
  const advance = (minutes: number) => {
    clock.time = new Date(
      Date.parse(clock.time) + minutes * 60_000,
    ).toISOString();
  };

  beforeEach(() => {
    tmp = makeTempDir();
    db = openDb(":memory:");
    clock = {
      time: "2026-03-01T01:00:00.000Z",
      now() {
        const now = new Date(clock.time);
        clock.time = new Date(now.getTime() + 1000).toISOString();
        return now;
      },
    };
    migrate(db, { clock });
    source = makeRepo(path.join(tmp, "source"));
    dirs = {
      reposDir: path.join(tmp, "data", "repos"),
      workDir: path.join(tmp, "work"),
    };
    logsDir = path.join(tmp, "data", "logs");
    launcher = new FakeLauncher();
    logs = [];
    const push =
      (level: string) =>
      (event: string, fields: LogFields = {}) => {
        logs.push({ level, event, fields });
      };
    logger = { info: push("info"), warn: push("warn"), error: push("error") };
    deps = {
      db,
      clock,
      git: createGit(),
      launcher,
      dirs,
      logsDir,
      sourceFor: () => ({ url: source }),
      commitAuthor: AUTHOR,
    };
    setFactoryYml(SHA, VALID_FACTORY_YML);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("1回の確認", () => {
    it("既定ブランチの最新を取り出した確認用の場所で、保存済みの setup を、トークンなしで実行する", async () => {
      commitFile(source, "latest.txt", "latest\n");
      let seen: string[] = [];
      launcher.onRun = () => {
        seen = fs.readdirSync(path.join(preflightDir(), "repo"));
      };

      const result = await run();

      expect(launcher.requests).toEqual([
        {
          repo: REPO,
          workspace: "preflight",
          argv: ["sh", "-c", "example-setup"],
          claude_token: false,
          timeout_sec: 600,
        },
      ]);
      // 起動係が受け付ける形になっている。
      expect(parseRunRequest(launcher.requests[0]).ok).toBe(true);
      expect(seen).toContain("latest.txt");
      expect(result.kind).toBe("recorded");
    });

    it("通ったら、条件とあわせて記録し、確認用の場所を消す", async () => {
      const result = await run();

      const stored = readPreflight(db, REPO);
      expect(result).toEqual({ kind: "recorded", record: stored });
      expect(stored).toMatchObject({
        repo: REPO,
        status: "passed",
        image: IMAGE,
        factoryYmlSha: SHA,
        command: "example-setup",
        exitCode: 0,
        timedOut: false,
        outputTail: "",
      });
      expect(stored?.checkedAt).toMatch(/^2026-03-01T01:00:\d\d\.000Z$/);
      expect(fs.existsSync(preflightDir())).toBe(false);
    });

    it("通らなければ、コマンド、終了コード、出力の末尾を記録する", async () => {
      launcher.answers.push(
        ok({
          exit_code: 127,
          stdout: "installing\n",
          stderr: "sh: 1: example-tool: not found\n",
        }),
      );

      const result = await run();

      expect(result.kind).toBe("recorded");
      expect(readPreflight(db, REPO)).toMatchObject({
        status: "failed",
        command: "example-setup",
        exitCode: 127,
        timedOut: false,
        outputTail: "installing\n\nsh: 1: example-tool: not found",
      });
      expect(fs.existsSync(preflightDir())).toBe(false);
    });

    it("時間切れは、通らなかった結果として記録する", async () => {
      launcher.answers.push(ok({ exit_code: null, timed_out: true }));

      await run();

      expect(readPreflight(db, REPO)).toMatchObject({
        status: "failed",
        exitCode: null,
        timedOut: true,
      });
    });

    it("出力の全体をログのファイルに残し、トークンに見える文字列は、記録にもログにも残さない", async () => {
      launcher.answers.push(
        ok({
          exit_code: 1,
          stdout: `token=${SECRET}\n`,
          stderr: `again ${SECRET}\n`,
        }),
      );

      await run();

      const stored = readPreflight(db, REPO);
      expect(stored?.outputTail).toContain("token=sk-ant-***");
      expect(JSON.stringify(stored)).not.toContain(SECRET);
      const logPath = stored?.logPath ?? "";
      expect(path.dirname(logPath)).toBe(
        path.join(logsDir, "owner", "name", "preflight"),
      );
      expect(path.basename(logPath)).toMatch(
        /^\d{8}T\d{6}\.\d{3}Z-preflight\.log$/,
      );
      const text = fs.readFileSync(logPath, "utf8");
      expect(text).toContain('"outcome": "failed"');
      expect(text).toContain('"exit_code": 1');
      expect(text).toContain("--- setup stdout ---\ntoken=sk-ant-***");
      expect(text).toContain("again sk-ant-***");
      expect(text).not.toContain(SECRET);
      const raw = db.prepare("SELECT * FROM preflights").all();
      expect(JSON.stringify(raw)).not.toContain(SECRET);
    });

    it("記録は製品ごとに1行で、新しい結果で置き換わる", async () => {
      launcher.answers.push(ok({ exit_code: 1, stderr: "boom\n" }));
      await run();
      await run();

      const rows = db.prepare("SELECT status FROM preflights").all();
      expect(rows).toEqual([{ status: "passed" }]);
      expect(readPreflight(db, REPO)?.outputTail).toBe("");
    });

    it("イシューの作業場所には触れない", async () => {
      const issue = await prepareWorkspace(
        { git: deps.git },
        { dirs, repo: REPO, issue: 7, source: { url: source }, author: AUTHOR },
      );
      fs.writeFileSync(path.join(issue.repoDir, "work.txt"), "work\n");

      await run();

      expect(
        fs.readFileSync(path.join(issue.repoDir, "work.txt"), "utf8"),
      ).toBe("work\n");
    });

    it("起動係に届かない、依頼を拒否された場合は、結果として記録しない", async () => {
      launcher.answers.push(new Error(`起動係に届きません: ${SECRET}`));

      const result = await run();

      expect(result).toEqual({
        kind: "not_run",
        reason: "起動係に届きません: sk-ant-***",
      });
      expect(readPreflight(db, REPO)).toBeNull();
      expect(fs.existsSync(preflightDir())).toBe(false);
    });

    it("取得できなければ、コマンドを実行せず、記録もしない", async () => {
      deps = { ...deps, sourceFor: () => ({ url: path.join(tmp, "nowhere") }) };

      const result = await run();

      expect(result.kind).toBe("not_run");
      expect(launcher.requests).toEqual([]);
      expect(readPreflight(db, REPO)).toBeNull();
    });

    it("factory.yml が未取得か不正なら、何も実行せず、記録もしない", async () => {
      setFactoryYml(null, null);
      expect(await run()).toMatchObject({ kind: "not_run" });
      setFactoryYml("sha-bad", null);
      const result = await run();
      expect(result).toMatchObject({ kind: "not_run" });
      if (result.kind === "not_run") expect(result.reason).toContain("不正");
      expect(launcher.requests).toEqual([]);
      expect(fs.existsSync(dirs.workDir)).toBe(false);
    });

    it("前の記録があっても、実行できなかった確認では書き換えない", async () => {
      savePreflight(db, record({ status: "failed", exitCode: 1 }));
      launcher.answers.push(new Error("起動係が依頼を拒否しました"));

      await run();

      expect(readPreflight(db, REPO)).toEqual(
        record({ status: "failed", exitCode: 1 }),
      );
    });

    describe("製品の Dockerfile", () => {
      const DOCKERFILE_PATH = ".factory/worker.Dockerfile";
      const setDockerfile = (sha: string | null) => {
        setFactoryYml(
          SHA,
          `${VALID_FACTORY_YML}worker:\n  dockerfile: ${DOCKERFILE_PATH}\n`,
        );
        db.prepare(
          `UPDATE repos SET worker_dockerfile = ?, worker_dockerfile_sha = ?,
             worker_dockerfile_path = ? WHERE repo = ?`,
        ).run(
          sha === null ? null : "FROM example\n",
          sha,
          DOCKERFILE_PATH,
          REPO,
        );
      };
      const buildError = (
        overrides: Partial<
          ConstructorParameters<typeof ImageBuildError>[0]
        > = {},
      ) =>
        new ImageBuildError({
          exitCode: 1,
          timedOut: false,
          output:
            "イメージのビルドに失敗しました\nStep 3/3 : RUN example-install\nexample-install: not found",
          truncated: false,
          ...overrides,
        });

      it("通ったら、Dockerfile の sha も条件として記録する", async () => {
        setDockerfile("d-1");
        await run();
        expect(readPreflight(db, REPO)).toMatchObject({
          status: "passed",
          dockerfileSha: "d-1",
          command: "example-setup",
        });
      });

      it("イメージのビルドに失敗したら、通らなかった結果として、ビルドの出力とあわせて記録する", async () => {
        setDockerfile("d-1");
        launcher.answers.push(buildError());

        const result = await run();

        expect(result.kind).toBe("recorded");
        const stored = readPreflight(db, REPO);
        expect(stored).toMatchObject({
          status: "failed",
          dockerfileSha: "d-1",
          command: IMAGE_BUILD_COMMAND,
          exitCode: 1,
          timedOut: false,
        });
        expect(stored?.outputTail).toContain("example-install: not found");
        const log = fs.readFileSync(stored?.logPath ?? "", "utf8");
        expect(log).toContain('"command": "(ワーカーのイメージのビルド)"');
        expect(log).toContain('"dockerfile_sha": "d-1"');
        expect(log).toContain("Step 3/3 : RUN example-install");
        expect(fs.existsSync(preflightDir())).toBe(false);
      });

      it("検査に通らない Dockerfile と、ビルドの時間切れも、通らなかった結果になる", async () => {
        setDockerfile("d-1");
        launcher.answers.push(
          buildError({
            exitCode: null,
            output: "Dockerfile を使えません(3行目): ADD は使えません",
          }),
        );
        await run();
        expect(readPreflight(db, REPO)).toMatchObject({
          status: "failed",
          command: IMAGE_BUILD_COMMAND,
          exitCode: null,
          outputTail: "Dockerfile を使えません(3行目): ADD は使えません",
        });

        launcher.answers.push(buildError({ exitCode: 143, timedOut: true }));
        await run();
        expect(readPreflight(db, REPO)).toMatchObject({
          status: "failed",
          timedOut: true,
        });
      });

      it("関門は、ビルドに失敗した製品を failed にし、Dockerfile が変わったら確かめ直す", async () => {
        setDockerfile("d-1");
        launcher.answers.push(buildError());
        const gate = createPreflightGate({
          ...deps,
          logger,
          imageFor: () => IMAGE,
          timeoutSec: 600,
        });
        gate.ensure(REPO);
        await gate.idle();
        expect(gate.statusOf(REPO)).toBe("failed");
        expect(
          logs.filter((line) => line.event === "preflight.failed")[0]?.fields,
        ).toMatchObject({
          command: IMAGE_BUILD_COMMAND,
          dockerfile_sha: "d-1",
        });

        // 同じ条件の間は、確かめ直さない(ビルドも頼まない)。
        gate.ensure(REPO);
        await gate.idle();
        expect(launcher.requests).toHaveLength(1);

        // 既定ブランチの Dockerfile が変わると、確かめ直して、通る。
        setDockerfile("d-2");
        expect(gate.statusOf(REPO)).toBe("pending");
        gate.ensure(REPO);
        await gate.idle();
        expect(gate.statusOf(REPO)).toBe("passed");
        expect(readPreflight(db, REPO)?.dockerfileSha).toBe("d-2");
      });
    });

    it("途中で止められたら、記録せずに戻り、確認用の場所を消す", async () => {
      const controller = new AbortController();
      launcher.answers.push(() => new Promise<RunResult>(() => {}));
      launcher.onRun = () => controller.abort();

      const result = await run(controller.signal);

      expect(result).toEqual({ kind: "interrupted" });
      expect(readPreflight(db, REPO)).toBeNull();
      expect(fs.existsSync(preflightDir())).toBe(false);
    });

    it("記録が想定外の内容なら、原因の分かるメッセージで失敗する", () => {
      savePreflight(db, record());
      db.pragma("ignore_check_constraints = ON");
      db.prepare("UPDATE preflights SET status = 'maybe'").run();
      expect(() => readPreflight(db, REPO)).toThrow(/着手前の確認の記録/);
    });
  });

  describe("関門", () => {
    const newGate = (image = IMAGE) =>
      createPreflightGate({
        ...deps,
        logger,
        imageFor: () => image,
        timeoutSec: 600,
      });
    const logged = (event: string) =>
      logs.filter((line) => line.event === event);

    it("確かめていない製品は pending で、確認が終わると passed になる", async () => {
      const gate = newGate();
      expect(gate.statusOf(REPO)).toBe("pending");
      // 状態を読むだけでは、確認を始めない。
      expect(launcher.requests).toEqual([]);

      gate.ensure(REPO);
      await gate.idle();

      expect(gate.statusOf(REPO)).toBe("passed");
      expect(logged("preflight.passed")).toHaveLength(1);
    });

    it("通っている間は、何度頼まれても確かめ直さない", async () => {
      const gate = newGate();
      gate.ensure(REPO);
      await gate.idle();
      for (let i = 0; i < 5; i += 1) {
        advance(600);
        gate.ensure(REPO);
        await gate.idle();
      }
      expect(launcher.requests).toHaveLength(1);
    });

    it("確かめている途中に頼まれても、確認は1つだけ", async () => {
      let release: (result: RunResult) => void = () => {};
      launcher.answers.push(
        () =>
          new Promise<RunResult>((resolve) => {
            release = resolve;
          }),
      );
      const gate = newGate();
      gate.ensure(REPO);
      gate.ensure(REPO);
      await new Promise((resolve) => setTimeout(resolve, 200));
      gate.ensure(REPO);
      expect(gate.statusOf(REPO)).toBe("pending");
      release(ok());
      await gate.idle();

      expect(launcher.requests).toHaveLength(1);
      expect(gate.statusOf(REPO)).toBe("passed");
    });

    it("通らなければ failed になり、理由をログに出す。トークンに見える文字列は伏せる", async () => {
      launcher.answers.push(
        ok({ exit_code: 127, stderr: `example-tool: not found ${SECRET}\n` }),
      );
      const gate = newGate();
      gate.ensure(REPO);
      await gate.idle();

      expect(gate.statusOf(REPO)).toBe("failed");
      const [line] = logged("preflight.failed");
      expect(line?.level).toBe("warn");
      expect(line?.fields).toMatchObject({
        repo: REPO,
        image: IMAGE,
        factory_yml_sha: SHA,
        command: "example-setup",
        exit_code: 127,
        timed_out: false,
        output_tail: "example-tool: not found sk-ant-***",
      });
      expect(line?.fields.log_path).toBe(readPreflight(db, REPO)?.logPath);
      expect(JSON.stringify(logs)).not.toContain(SECRET);
    });

    it("通らなかった後は、決まった時間がたつまで確かめ直さず、たったら確かめ直す", async () => {
      launcher.answers.push(ok({ exit_code: 1 }));
      const gate = newGate();
      gate.ensure(REPO);
      await gate.idle();

      for (let i = 0; i < 5; i += 1) {
        advance(10);
        gate.ensure(REPO);
        await gate.idle();
      }
      expect(launcher.requests).toHaveLength(1);
      expect(logged("preflight.failed")).toHaveLength(1);

      advance(FAILED_RECHECK_MINUTES);
      expect(gate.statusOf(REPO)).toBe("pending");
      gate.ensure(REPO);
      await gate.idle();
      expect(launcher.requests).toHaveLength(2);
      expect(gate.statusOf(REPO)).toBe("passed");
    });

    it("factory.yml が変わったら、確かめ直す", async () => {
      launcher.answers.push(ok({ exit_code: 1 }));
      const gate = newGate();
      gate.ensure(REPO);
      await gate.idle();
      expect(gate.statusOf(REPO)).toBe("failed");

      setFactoryYml(
        "sha-2",
        VALID_FACTORY_YML.replace("example-setup", "other-setup"),
      );
      expect(gate.statusOf(REPO)).toBe("pending");
      gate.ensure(REPO);
      await gate.idle();

      expect(launcher.requests[1]?.argv).toEqual(["sh", "-c", "other-setup"]);
      expect(readPreflight(db, REPO)).toMatchObject({
        status: "passed",
        factoryYmlSha: "sha-2",
      });
    });

    it("イメージの名前が変わったら、確かめ直す", async () => {
      const first = newGate();
      first.ensure(REPO);
      await first.idle();

      const second = newGate("other-image");
      expect(second.statusOf(REPO)).toBe("pending");
      second.ensure(REPO);
      await second.idle();

      expect(launcher.requests).toHaveLength(2);
      expect(readPreflight(db, REPO)?.image).toBe("other-image");
    });

    it("結果は記録にあるので、起動し直しても確かめ直さない", async () => {
      const first = newGate();
      first.ensure(REPO);
      await first.idle();

      const second = newGate();
      expect(second.statusOf(REPO)).toBe("passed");
      second.ensure(REPO);
      await second.idle();
      expect(launcher.requests).toHaveLength(1);
    });

    it("実行できなかった確認は pending のままで、次に頼まれたらやり直す", async () => {
      launcher.answers.push(new Error("起動係に届きません"));
      const gate = newGate();
      gate.ensure(REPO);
      await gate.idle();

      expect(gate.statusOf(REPO)).toBe("pending");
      expect(logged("preflight.not_run")).toHaveLength(1);
      expect(logged("preflight.not_run")[0]?.fields.reason).toContain(
        "起動係に届きません",
      );

      gate.ensure(REPO);
      await gate.idle();
      expect(gate.statusOf(REPO)).toBe("passed");
    });

    it("止めると、確かめている途中の確認を中断し、以後は始めない", async () => {
      launcher.answers.push(() => new Promise<RunResult>(() => {}));
      const gate = newGate();
      gate.ensure(REPO);
      await new Promise((resolve) => setTimeout(resolve, 200));

      await gate.stop();

      expect(logged("preflight.interrupted")).toHaveLength(1);
      expect(readPreflight(db, REPO)).toBeNull();
      gate.ensure(REPO);
      await gate.idle();
      expect(launcher.requests).toHaveLength(1);
    });
  });
});
