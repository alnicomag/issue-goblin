import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLauncherClient,
  LauncherAbortedError,
} from "../src/launcher/client.ts";
import type { ContainerSettings } from "../src/launcher/container.ts";
import {
  type CommandOptions,
  type CommandResult,
  createDockerCli,
  type Docker,
} from "../src/launcher/docker.ts";
import { createLauncher, type LauncherDeps } from "../src/launcher/launcher.ts";
import { dockerEnvFrom, settingsFromEnv } from "../src/launcher/main.ts";
import { createLauncherServer } from "../src/launcher/server.ts";
import { parseConfig } from "../src/office/config.ts";
import {
  type LogFields,
  type Logger,
  silentLogger,
} from "../src/office/log.ts";

const CONFIG = parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: owner/first
    token_env: TOKEN_FIRST
  - repo: owner/second
    token_env: TOKEN_SECOND
    worker_image: second-worker
`);

const SETTINGS: ContainerSettings = {
  workVolume: "factory-work",
  network: "factory-workers",
  proxyUrl: "http://proxy:3128",
  user: "1000:1000",
  memory: "2g",
  pidsLimit: 512,
  cpus: "2",
  tmpSize: "1g",
};

const DUMMY_TOKEN = "dummy-claude-token-value";

interface Call {
  args: readonly string[];
  options: CommandOptions;
}

/** 偽のDocker。呼ばれた内容を記録し、`run` の結果は差し替えられる。 */
function fakeDocker(
  onRun: (call: Call) => Promise<CommandResult> | CommandResult = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  }),
) {
  const calls: Call[] = [];
  const docker: Docker = {
    async exec(args, options) {
      const call = { args, options };
      calls.push(call);
      if (args[0] === "run") return onRun(call);
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    },
  };
  return {
    docker,
    calls,
    runs: () => calls.filter((call) => call.args[0] === "run"),
    kills: () => calls.filter((call) => call.args[0] === "kill"),
  };
}

function launcherWith(
  docker: Docker,
  overrides: Partial<LauncherDeps> = {},
): ReturnType<typeof createLauncher> {
  let counter = 0;
  return createLauncher({
    config: CONFIG,
    settings: SETTINGS,
    docker,
    claudeToken: DUMMY_TOKEN,
    dockerEnv: { PATH: "/usr/bin" },
    logger: silentLogger,
    newContainerName: () => {
      counter += 1;
      return `factory-worker-test-${counter}`;
    },
    killRetryMs: 1,
    ...overrides,
  });
}

const REQUEST = {
  repo: "owner/first",
  issue: 12,
  argv: ["sh", "-c", "echo hello"],
  timeout_sec: 60,
};

describe("起動係", () => {
  it("依頼を受けると、ワーカーのコンテナを立てて結果を返す", async () => {
    const fake = fakeDocker(() => ({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
      truncated: false,
    }));
    const response = await launcherWith(fake.docker).run({
      ...REQUEST,
      stdin: "input",
    });

    expect(response).toEqual({
      ok: true,
      result: {
        exit_code: 3,
        timed_out: false,
        stdout: "out",
        stderr: "err",
        truncated: false,
      },
    });
    const [run] = fake.runs();
    expect(run?.args).toContain(
      "--mount=type=volume,src=factory-work,dst=/workspace,volume-subpath=owner/first/issue-12",
    );
    expect(run?.args.slice(-4)).toEqual([
      "factory-worker",
      "sh",
      "-c",
      "echo hello",
    ]);
    expect(run?.options.stdin).toBe("input");
  });

  it("イメージは設定から決まり、リポジトリごとの指定が使われる", async () => {
    const fake = fakeDocker();
    await launcherWith(fake.docker).run({ ...REQUEST, repo: "owner/second" });
    const args = fake.runs()[0]?.args ?? [];
    expect(args[args.indexOf("--") + 1]).toBe("second-worker");
  });

  it("作業場所のパスには、依頼の書き方ではなく、設定の書き方を使う", async () => {
    const fake = fakeDocker();
    await launcherWith(fake.docker).run({ ...REQUEST, repo: "OWNER/First" });
    expect(
      fake
        .runs()[0]
        ?.args.some((arg) =>
          arg.endsWith("volume-subpath=owner/first/issue-12"),
        ),
    ).toBe(true);
  });

  it("設定にないリポジトリの依頼は、コンテナを立てずに拒否する", async () => {
    const fake = fakeDocker();
    const response = await launcherWith(fake.docker).run({
      ...REQUEST,
      repo: "owner/unknown",
    });
    expect(response).toEqual({
      ok: false,
      error: "設定にないリポジトリです: owner/unknown",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("置き場所の外のパスをマウントさせる依頼は、コンテナを立てずに拒否する", async () => {
    const fake = fakeDocker();
    const launcher = launcherWith(fake.docker);
    const attempts: unknown[] = [
      { ...REQUEST, repo: "../first" },
      { ...REQUEST, repo: "owner/.." },
      { ...REQUEST, repo: "owner/first/../../second" },
      { ...REQUEST, repo: "/" },
      { ...REQUEST, issue: "12/../../../second/issue-1" },
      { ...REQUEST, issue: -1 },
      { ...REQUEST, mounts: ["/var/run/docker.sock:/var/run/docker.sock"] },
      { ...REQUEST, volume: "factory-data" },
      { ...REQUEST, subpath: "owner/second/issue-1" },
    ];
    for (const attempt of attempts) {
      const response = await launcher.run(attempt);
      expect(response.ok, JSON.stringify(attempt)).toBe(false);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("形式に合わない依頼は、コンテナを立てずに拒否する", async () => {
    const fake = fakeDocker();
    const launcher = launcherWith(fake.docker);
    for (const raw of [null, "run", 12, [], {}, { repo: "owner/first" }]) {
      const response = await launcher.run(raw);
      expect(response.ok, JSON.stringify(raw)).toBe(false);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("Claudeのトークンは、求められたときだけ、dockerの環境変数として渡す", async () => {
    const fake = fakeDocker();
    const launcher = launcherWith(fake.docker);
    await launcher.run(REQUEST);
    await launcher.run({ ...REQUEST, claude_token: true });

    const [without, withToken] = fake.runs();
    expect(without?.options.env).toEqual({ PATH: "/usr/bin" });
    expect(without?.args.join(" ")).not.toContain("CLAUDE");
    expect(withToken?.options.env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: DUMMY_TOKEN,
    });
    // 値は引数に書かない(プロセスの一覧やコンテナの定義に、平文で残さない)。
    expect(withToken?.args.join(" ")).not.toContain(DUMMY_TOKEN);
    expect(withToken?.args).toContain("--env=CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("トークンが設定されていなければ、トークンを求める依頼は拒否する", async () => {
    const fake = fakeDocker();
    const response = await launcherWith(fake.docker, {
      claudeToken: undefined,
    }).run({ ...REQUEST, claude_token: true });
    expect(response.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("ログに、トークン、引数、標準入力、出力を出さない", async () => {
    const lines: string[] = [];
    const record = (event: string, fields?: LogFields) =>
      lines.push(JSON.stringify({ event, ...fields }));
    const logger: Logger = { info: record, warn: record, error: record };
    const fake = fakeDocker(() => ({
      exitCode: 0,
      stdout: "secret-output",
      stderr: "secret-error",
      truncated: false,
    }));
    await launcherWith(fake.docker, { logger }).run({
      ...REQUEST,
      argv: ["secret-argument"],
      stdin: "secret-input",
      claude_token: true,
    });

    const text = lines.join("\n");
    expect(text).toContain("launcher.run_finished");
    for (const secret of [
      DUMMY_TOKEN,
      "secret-argument",
      "secret-input",
      "secret-output",
      "secret-error",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("時間の上限を過ぎたら、コンテナを止めて、時間切れとして返す", async () => {
    let fire: () => void = () => {};
    let finish: (result: CommandResult) => void = () => {};
    const fake = fakeDocker(
      () =>
        new Promise<CommandResult>((resolve) => {
          finish = resolve;
        }),
    );
    const launcher = launcherWith(fake.docker, {
      setTimer: (callback, ms) => {
        // 時間の上限のタイマーだけを、手で進められるようにする。
        if (ms === 60_000) {
          fire = callback;
          return () => {};
        }
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });

    const pending = launcher.run(REQUEST);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.kills()).toHaveLength(0);

    fire();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.kills().map((call) => call.args)).toEqual([
      ["kill", "factory-worker-test-1"],
    ]);

    // 止められたコンテナは、シグナルによる終了コードで終わる。
    finish({ exitCode: 137, stdout: "", stderr: "", truncated: false });
    const response = await pending;
    expect(response).toMatchObject({
      ok: true,
      result: { exit_code: 137, timed_out: true },
    });
  });

  it("依頼した側がいなくなったら、コンテナを止める", async () => {
    let finish: (result: CommandResult) => void = () => {};
    const fake = fakeDocker(
      () =>
        new Promise<CommandResult>((resolve) => {
          finish = resolve;
        }),
    );
    const abandoned = new AbortController();
    const pending = launcherWith(fake.docker).run(REQUEST, abandoned.signal);
    await new Promise((resolve) => setImmediate(resolve));

    abandoned.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.kills().map((call) => call.args)).toEqual([
      ["kill", "factory-worker-test-1"],
    ]);
    finish({ exitCode: 137, stdout: "", stderr: "", truncated: false });
    await pending;
  });

  it("dockerを起動できなければ、原因の分かるメッセージで失敗を返す", async () => {
    const fake = fakeDocker(() => {
      throw new Error("docker を起動できません");
    });
    const response = await launcherWith(fake.docker).run(REQUEST);
    expect(response).toEqual({ ok: false, error: "docker を起動できません" });
  });

  it("残っていたワーカーのコンテナを、目印で探して消す", async () => {
    const calls: Array<readonly string[]> = [];
    const docker: Docker = {
      async exec(args) {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: args[0] === "ps" ? "abc123\ndef456\n" : "",
          stderr: "",
          truncated: false,
        };
      },
    };
    expect(await launcherWith(docker).removeLeftovers()).toBe(2);
    expect(calls).toEqual([
      ["ps", "--all", "--quiet", "--filter=label=factory.worker=factory-work"],
      ["rm", "--force", "abc123", "def456"],
    ]);
  });

  it("残っているコンテナがなければ、何も消さない", async () => {
    const fake = fakeDocker();
    expect(await launcherWith(fake.docker).removeLeftovers()).toBe(0);
    expect(fake.calls.map((call) => call.args[0])).toEqual(["ps"]);
  });
});

describe("起動時のイメージの確認", () => {
  /** 手元にあるイメージを決められる偽のDocker。 */
  function dockerWithImages(present: readonly string[]) {
    const fake = fakeDocker();
    const inspected: string[] = [];
    const docker: Docker = {
      async exec(args, options) {
        if (args[0] === "image" && args[1] === "inspect") {
          const image = args.at(-1) ?? "";
          inspected.push(image);
          return present.includes(image)
            ? {
                exitCode: 0,
                stdout: "sha256:0\n",
                stderr: "",
                truncated: false,
              }
            : {
                exitCode: 1,
                stdout: "",
                stderr: `Error response from daemon: No such image: ${image}`,
                truncated: false,
              };
        }
        return fake.docker.exec(args, options);
      },
    };
    return { docker, inspected, runs: fake.runs };
  }

  function recorder() {
    const records: Array<{ level: string; event: string; fields?: LogFields }> =
      [];
    const at = (level: string) => (event: string, fields?: LogFields) => {
      records.push({ level, event, ...(fields ? { fields } : {}) });
    };
    const logger: Logger = {
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    };
    return { logger, records };
  }

  it("全体のイメージが手元になければ、イメージと、それを使う製品をログに出す", async () => {
    // ビルドした名前(other-worker)と、設定の名前(factory-worker)が食い違っている。
    const fake = dockerWithImages(["other-worker", "second-worker"]);
    const { logger, records } = recorder();
    const missing = await launcherWith(fake.docker, { logger }).checkImages();

    expect(missing).toEqual(["factory-worker"]);
    expect(records).toEqual([
      {
        level: "warn",
        event: "launcher.image_missing",
        fields: { image: "factory-worker", repos: ["owner/first"] },
      },
    ]);
  });

  it("製品ごとのイメージが手元になければ、そのイメージをログに出す", async () => {
    const fake = dockerWithImages(["factory-worker"]);
    const { logger, records } = recorder();
    const missing = await launcherWith(fake.docker, { logger }).checkImages();

    expect(missing).toEqual(["second-worker"]);
    expect(records.map((record) => record.fields)).toEqual([
      { image: "second-worker", repos: ["owner/second"] },
    ]);
  });

  it("すべて手元にあれば、何も出さない。同じイメージは1回だけ確かめる", async () => {
    const config = parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: owner/first
    token_env: TOKEN_FIRST
  - repo: owner/second
    token_env: TOKEN_SECOND
`);
    const fake = dockerWithImages(["factory-worker"]);
    const { logger, records } = recorder();
    const missing = await launcherWith(fake.docker, {
      config,
      logger,
    }).checkImages();

    expect(missing).toEqual([]);
    expect(records).toEqual([]);
    expect(fake.inspected).toEqual(["factory-worker"]);
  });

  it("イメージの名前を、オプションとして解釈させない", async () => {
    const calls: Array<readonly string[]> = [];
    const docker: Docker = {
      async exec(args) {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "", truncated: false };
      },
    };
    await launcherWith(docker).checkImages();
    expect(calls).toEqual([
      ["image", "inspect", "--format={{.Id}}", "--", "factory-worker"],
      ["image", "inspect", "--format={{.Id}}", "--", "second-worker"],
    ]);
  });

  it("イメージがなくても止まらず、イメージのある製品の依頼は通る", async () => {
    const fake = dockerWithImages(["second-worker"]);
    const launcher = launcherWith(fake.docker);
    await expect(launcher.checkImages()).resolves.toEqual(["factory-worker"]);

    const response = await launcher.run({ ...REQUEST, repo: "owner/second" });
    expect(response.ok).toBe(true);
    expect(fake.runs()).toHaveLength(1);
  });

  it("確かめる途中でdockerを呼べなくても止まらず、残りを確かめる", async () => {
    const { logger, records } = recorder();
    const docker: Docker = {
      async exec(args) {
        if (args.at(-1) === "factory-worker") {
          throw new Error("docker を起動できません");
        }
        return { exitCode: 1, stdout: "", stderr: "", truncated: false };
      },
    };
    const missing = await launcherWith(docker, { logger }).checkImages();

    expect(missing).toEqual(["second-worker"]);
    expect(records.map((record) => [record.level, record.event])).toEqual([
      ["error", "launcher.image_check_failed"],
      ["warn", "launcher.image_missing"],
    ]);
    expect(records[0]?.fields).toMatchObject({
      image: "factory-worker",
      repos: ["owner/first"],
    });
  });
});

describe("起動係の環境変数", () => {
  const ENV = {
    WORK_VOLUME: "factory-work",
    WORKER_NETWORK: "factory-workers",
    WORKER_PROXY_URL: "http://proxy:3128",
  };

  it("必須の項目と既定値を読む", () => {
    expect(settingsFromEnv(ENV)).toEqual(SETTINGS);
  });

  it("欠けている項目や、オプションに見える値は、項目名の分かるメッセージで失敗する", () => {
    expect(() => settingsFromEnv({})).toThrow("WORK_VOLUME");
    expect(() =>
      settingsFromEnv({ ...ENV, WORK_VOLUME: "--privileged" }),
    ).toThrow("WORK_VOLUME");
    expect(() => settingsFromEnv({ ...ENV, WORK_VOLUME: "/var/run" })).toThrow(
      "WORK_VOLUME",
    );
    expect(() => settingsFromEnv({ ...ENV, WORKER_NETWORK: "host,x" })).toThrow(
      "WORKER_NETWORK",
    );
    expect(() => settingsFromEnv({ ...ENV, WORKER_USER: "root" })).toThrow(
      "WORKER_USER",
    );
    expect(() =>
      settingsFromEnv({ ...ENV, WORKER_PROXY_URL: "proxy:3128" }),
    ).toThrow("WORKER_PROXY_URL");
  });

  it("dockerコマンドには、決まった環境変数だけを渡す", () => {
    expect(
      dockerEnvFrom({
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: DUMMY_TOKEN,
        WORK_VOLUME: "factory-work",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/nonexistent" });
  });
});

describe("コマンドの実行", () => {
  // `docker` の代わりに、テストを動かしているNodeを使う。
  const cli = createDockerCli(process.execPath);
  const options = { env: {}, maxOutputBytes: 1024 };

  it("標準入力を渡し、出力と終了コードを受け取る", async () => {
    const result = await cli.exec(
      [
        "-e",
        "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => { process.stderr.write('warn'); process.exit(7); })",
      ],
      { ...options, stdin: "hello" },
    );
    expect(result).toEqual({
      exitCode: 7,
      stdout: "HELLO",
      stderr: "warn",
      truncated: false,
    });
  });

  it("環境変数は、渡したものだけが子プロセスに渡る", async () => {
    const result = await cli.exec(
      ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
      { ...options, env: { ONLY_THIS: "1" } },
    );
    expect(JSON.parse(result.stdout)).toEqual(["ONLY_THIS"]);
  });

  it("上限を超えた出力は切り、切ったことが分かる", async () => {
    const result = await cli.exec(
      ["-e", "process.stdout.write('x'.repeat(5000))"],
      options,
    );
    expect(result.stdout).toHaveLength(1024);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("止める合図で、コマンドを終わらせる", async () => {
    const stop = new AbortController();
    const pending = cli.exec(
      ["-e", "process.stdout.write('started'); setInterval(() => {}, 1000)"],
      { ...options, signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 200);
    const result = await pending;
    // シグナルで終わったので、終了コードはない。
    expect(result.exitCode).toBeNull();

    // すでに止められていれば、すぐに終わらせる。
    const stopped = await cli.exec(["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      signal: stop.signal,
    });
    expect(stopped.exitCode).toBeNull();
  });

  it("コマンドがなければ、原因の分かるメッセージで失敗する", async () => {
    await expect(
      createDockerCli("/nonexistent/docker").exec(["version"], options),
    ).rejects.toThrow("/nonexistent/docker を起動できません");
  });
});

describe("起動係の窓口", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function serve(docker: Docker): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
    const socketPath = path.join(dir, "launcher.sock");
    const server = createLauncherServer({
      launcher: launcherWith(docker),
      logger: silentLogger,
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    closers.push(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(() => {
            fs.rmSync(dir, { recursive: true, force: true });
            done();
          });
        }),
    );
    return socketPath;
  }

  it("事務局の側から依頼し、結果を受け取れる", async () => {
    const fake = fakeDocker((call) => ({
      exitCode: 0,
      stdout: `got:${call.options.stdin}`,
      stderr: "",
      truncated: false,
    }));
    const client = createLauncherClient({
      socketPath: await serve(fake.docker),
    });
    expect(await client.run({ ...REQUEST, stdin: "ping" })).toEqual({
      exit_code: 0,
      timed_out: false,
      stdout: "got:ping",
      stderr: "",
      truncated: false,
    });
  });

  it("拒否された依頼は、理由の分かる例外になる", async () => {
    const fake = fakeDocker();
    const client = createLauncherClient({
      socketPath: await serve(fake.docker),
    });
    await expect(
      client.run({ ...REQUEST, repo: "owner/unknown" }),
    ).rejects.toThrow(
      "起動係が依頼を拒否しました: 設定にないリポジトリです: owner/unknown",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("起動係に届かなければ、ソケットの場所の分かる例外になる", async () => {
    const client = createLauncherClient({ socketPath: "/nonexistent/sock" });
    await expect(client.run(REQUEST)).rejects.toThrow(
      "起動係に届きません: /nonexistent/sock",
    );
  });

  it("依頼した側が切断すると、コンテナを止める", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (result: CommandResult) => void = () => {};
    const fake = fakeDocker(
      () =>
        new Promise<CommandResult>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const socketPath = await serve(fake.docker);

    const http = await import("node:http");
    const body = JSON.stringify(REQUEST);
    const call = http.request({
      socketPath,
      path: "/run",
      method: "POST",
      headers: { "Content-Length": Buffer.byteLength(body) },
    });
    call.on("error", () => {});
    call.end(body);
    await running;
    call.destroy();

    await expect
      .poll(() => fake.kills().map((kill) => kill.args))
      .toEqual([["kill", "factory-worker-test-1"]]);
    finish({ exitCode: 137, stdout: "", stderr: "", truncated: false });
  });

  it("事務局の側から中断すると、例外で戻り、コンテナを止める", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (result: CommandResult) => void = () => {};
    const fake = fakeDocker(
      () =>
        new Promise<CommandResult>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const client = createLauncherClient({
      socketPath: await serve(fake.docker),
    });
    const controller = new AbortController();
    const pending = client.run(REQUEST, { signal: controller.signal });
    await running;
    controller.abort();

    await expect(pending).rejects.toThrow("起動係への依頼を中断しました");
    await expect(pending).rejects.toBeInstanceOf(LauncherAbortedError);
    await expect
      .poll(() => fake.kills().map((kill) => kill.args))
      .toEqual([["kill", "factory-worker-test-1"]]);
    finish({ exitCode: 137, stdout: "", stderr: "", truncated: false });
  });

  it("すでに中断されていれば、依頼せずに例外で戻る", async () => {
    const fake = fakeDocker();
    const client = createLauncherClient({
      socketPath: await serve(fake.docker),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.run(REQUEST, { signal: controller.signal }),
    ).rejects.toThrow("起動係への依頼を中断しました");
    await expect(
      client.run(REQUEST, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(LauncherAbortedError);
    expect(fake.calls).toHaveLength(0);
  });

  it("JSONでない依頼と、知らない宛先は拒否する", async () => {
    const fake = fakeDocker();
    const socketPath = await serve(fake.docker);
    const http = await import("node:http");
    const send = (method: string, url: string, body: string) =>
      new Promise<number>((resolve, reject) => {
        const call = http.request(
          { socketPath, path: url, method },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        call.on("error", reject);
        call.end(body);
      });

    expect(await send("POST", "/run", "not json")).toBe(400);
    expect(await send("POST", "/other", "{}")).toBe(404);
    expect(await send("GET", "/run", "")).toBe(404);
    expect(await send("GET", "/health", "")).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });
});
