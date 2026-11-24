import { describe, expect, it } from "vitest";
import type { ContainerSettings } from "../src/launcher/container.ts";
import type {
  CommandOptions,
  CommandResult,
  Docker,
} from "../src/launcher/docker.ts";
import { checkDockerfile } from "../src/launcher/dockerfile.ts";
import {
  BUILDER_PROBE_DOCKERFILE,
  buildBuildArgs,
  buildProbeArgs,
  builtImageName,
} from "../src/launcher/image.ts";
import { createLauncher, type LauncherDeps } from "../src/launcher/launcher.ts";
import {
  BUILD_TIMEOUT_SEC,
  MAX_DOCKERFILE_BYTES,
  parseRunRequest,
} from "../src/launcher/request.ts";
import { parseConfig } from "../src/office/config.ts";
import type { LogFields, Logger } from "../src/office/log.ts";

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
const DOCKERFILE =
  "ARG FACTORY_BASE_IMAGE\nFROM $FACTORY_BASE_IMAGE\nRUN true\n";
const BASE_ID = "sha256:base-1";

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  truncated: false,
});
const failed = (stderr = "", exitCode = 1): CommandResult => ({
  exitCode,
  stdout: "",
  stderr,
  truncated: false,
});

interface Call {
  args: readonly string[];
  options: CommandOptions;
}

/**
 * 偽のDocker。手元にあるイメージ(名前とID)を持ち、`build` が成功すると、付けた名前を足す。
 * `image ls` は、ビルドしたイメージの名前を返す。
 */
function fakeDocker(
  options: {
    onBuild?: (call: Call) => Promise<CommandResult> | CommandResult;
    /** 消せないイメージ(使用中)。 */
    inUse?: readonly string[];
  } = {},
) {
  const images = new Map<string, string>([
    ["factory-worker", BASE_ID],
    ["second-worker", "sha256:second-1"],
  ]);
  const built: string[] = [];
  const calls: Call[] = [];
  const docker: Docker = {
    async exec(args, execOptions) {
      const call = { args, options: execOptions };
      calls.push(call);
      const [command, sub] = args;
      if (command === "image" && sub === "inspect") {
        const id = images.get(args.at(-1) ?? "");
        return id === undefined ? failed("No such image") : ok(`${id}\n`);
      }
      if (command === "image" && sub === "ls") {
        return ok(`${built.join("\n")}\n`);
      }
      if (command === "image" && sub === "rm") {
        const image = args.at(-1) ?? "";
        if (options.inUse?.includes(image)) return failed("image is in use");
        images.delete(image);
        built.splice(built.indexOf(image), 1);
        return ok();
      }
      if (command === "build") {
        const result = (await options.onBuild?.(call)) ?? ok();
        const tag = args.find((arg) => arg.startsWith("--tag="))?.slice(6);
        if (result.exitCode === 0 && tag !== undefined) {
          images.set(tag, `sha256:${tag}`);
          built.push(tag);
        }
        return result;
      }
      return ok();
    },
  };
  const named = (command: string, sub?: string) =>
    calls.filter(
      (call) =>
        call.args[0] === command && (sub === undefined || call.args[1] === sub),
    );
  return {
    docker,
    images,
    built,
    calls,
    builds: () => named("build"),
    runs: () => named("run"),
    removals: () => named("image", "rm").map((call) => call.args.at(-1)),
  };
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

function launcherWith(docker: Docker, overrides: Partial<LauncherDeps> = {}) {
  let counter = 0;
  return createLauncher({
    config: CONFIG,
    settings: SETTINGS,
    docker,
    claudeToken: DUMMY_TOKEN,
    dockerEnv: { PATH: "/usr/bin" },
    logger: recorder().logger,
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
  dockerfile: DOCKERFILE,
};

const imageOf = (call: Call | undefined): string | undefined => {
  const args = call?.args ?? [];
  return args[args.indexOf("--") + 1];
};

const expectedImage = (
  dockerfile = DOCKERFILE,
  baseImageId = BASE_ID,
  repo = "owner/first",
) => builtImageName({ settings: SETTINGS, repo, baseImageId, dockerfile });

describe("ビルドするイメージの名前", () => {
  const base = {
    settings: SETTINGS,
    repo: "owner/first",
    baseImageId: BASE_ID,
    dockerfile: DOCKERFILE,
  };

  it("同じ内容なら同じ名前になり、Dockerの名前として使える形になる", () => {
    expect(builtImageName(base)).toBe(builtImageName({ ...base }));
    expect(builtImageName(base)).toMatch(/^factory-built:[0-9a-f]{32}$/);
    // リポジトリ名の大文字と小文字は区別しない(設定と同じ扱い)。
    expect(builtImageName({ ...base, repo: "Owner/First" })).toBe(
      builtImageName(base),
    );
  });

  it.each([
    ["Dockerfile", { dockerfile: `${DOCKERFILE}RUN true\n` }],
    ["基本イメージのID", { baseImageId: "sha256:base-2" }],
    ["リポジトリ", { repo: "owner/second" }],
    ["作業場所のボリューム", { settings: { workVolume: "other-work" } }],
  ])("%s が変わると、名前が変わる", (_name, change) => {
    expect(builtImageName({ ...base, ...change })).not.toBe(
      builtImageName(base),
    );
  });
});

describe("docker build の引数", () => {
  const args = buildBuildArgs({
    settings: SETTINGS,
    repo: "owner/first",
    baseImage: "factory-worker",
    image: "factory-built:abc",
  });

  it("ワーカーのネットワークに置き、外へはプロキシだけを通す", () => {
    expect(args).toEqual([
      "build",
      "--force-rm",
      "--network=factory-workers",
      "--memory=2g",
      "--build-arg=FACTORY_BASE_IMAGE=factory-worker",
      "--build-arg=HTTPS_PROXY=http://proxy:3128",
      "--build-arg=HTTP_PROXY=http://proxy:3128",
      "--build-arg=https_proxy=http://proxy:3128",
      "--build-arg=http_proxy=http://proxy:3128",
      "--label=factory.built=factory-work",
      "--label=factory.repo=owner/first",
      "--tag=factory-built:abc",
      "-",
    ]);
  });

  it("マウント、秘密、ホストのネットワーク、特権を渡す引数がない", () => {
    for (const arg of args) {
      expect(arg).not.toMatch(
        /^--(secret|ssh|mount|volume|privileged|add-host|file|pull|cap-add|security-opt)/,
      );
    }
    expect(args.filter((arg) => arg.startsWith("--network"))).toEqual([
      "--network=factory-workers",
    ]);
    expect(args.join(" ")).not.toContain(DUMMY_TOKEN);
  });

  it("オプションに見える名前は、引数にしない", () => {
    const build = (baseImage: string, image: string) => () =>
      buildBuildArgs({
        settings: SETTINGS,
        repo: "owner/first",
        baseImage,
        image,
      });
    expect(build("--privileged", "factory-built:abc")).toThrow(
      "名前が不正です",
    );
    expect(build("factory-worker", "")).toThrow("名前が不正です");
    expect(() =>
      buildProbeArgs({ settings: SETTINGS, baseImage: "-x" }),
    ).toThrow("名前が不正です");
  });
});

describe("依頼の Dockerfile", () => {
  it("省略でき、大きすぎるものと空のものは拒否する", () => {
    const { dockerfile: _dockerfile, ...plain } = REQUEST;
    expect(parseRunRequest(plain)).toMatchObject({ ok: true });
    expect(parseRunRequest(REQUEST)).toMatchObject({
      ok: true,
      value: { dockerfile: DOCKERFILE },
    });
    expect(parseRunRequest({ ...REQUEST, dockerfile: "" }).ok).toBe(false);
    const tooLarge = parseRunRequest({
      ...REQUEST,
      dockerfile: "#".repeat(MAX_DOCKERFILE_BYTES + 1),
    });
    expect(tooLarge).toMatchObject({ ok: false });
    if (!tooLarge.ok)
      expect(tooLarge.error).toContain("Dockerfile が大きすぎます");
  });

  it("イメージの名前は、依頼では選べない", () => {
    expect(parseRunRequest({ ...REQUEST, image: "example/image" }).ok).toBe(
      false,
    );
  });
});

describe("製品のイメージのビルド", () => {
  it("Dockerfile のない依頼は、ビルドせず、設定のイメージで動く", async () => {
    const fake = fakeDocker();
    const { dockerfile: _dockerfile, ...plain } = REQUEST;
    const response = await launcherWith(fake.docker).run(plain);
    expect(response).toMatchObject({ ok: true });
    if (response.ok) expect(response.result).not.toHaveProperty("build");
    expect(fake.builds()).toEqual([]);
    expect(imageOf(fake.runs()[0])).toBe("factory-worker");
  });

  it("Dockerfile を添えると、ビルドしたイメージで動く", async () => {
    const fake = fakeDocker();
    const response = await launcherWith(fake.docker).run(REQUEST);

    expect(response).toMatchObject({
      ok: true,
      result: { exit_code: 0, build: "built" },
    });
    const [build] = fake.builds();
    expect(build?.args).toEqual(
      buildBuildArgs({
        settings: SETTINGS,
        repo: "owner/first",
        baseImage: "factory-worker",
        image: expectedImage(),
      }),
    );
    // Dockerfile は、標準入力で渡す。旧ビルダーを選び、トークンは渡さない。
    expect(build?.options.stdin).toBe(DOCKERFILE);
    expect(build?.options.env).toEqual({
      PATH: "/usr/bin",
      DOCKER_BUILDKIT: "0",
    });
    expect(imageOf(fake.runs()[0])).toBe(expectedImage());
    // 実行の形は、設定のイメージのときと同じ。
    expect(fake.runs()[0]?.args).toContain("--network=factory-workers");
    expect(fake.runs()[0]?.args).toContain("--cap-drop=ALL");
  });

  it("Claudeのトークンを求める依頼でも、ビルドにはトークンを渡さない", async () => {
    const fake = fakeDocker();
    await launcherWith(fake.docker).run({ ...REQUEST, claude_token: true });
    const [build] = fake.builds();
    expect(JSON.stringify(build?.options.env)).not.toContain(DUMMY_TOKEN);
    expect(build?.args.join(" ")).not.toContain(DUMMY_TOKEN);
    expect(build?.args.join(" ")).not.toContain("CLAUDE");
    // 実行には渡る。
    expect(fake.runs()[0]?.options.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: DUMMY_TOKEN,
    });
  });

  it("基本イメージは、製品ごとの設定のものを使う", async () => {
    const fake = fakeDocker();
    await launcherWith(fake.docker).run({ ...REQUEST, repo: "owner/second" });
    expect(fake.builds()[0]?.args).toContain(
      "--build-arg=FACTORY_BASE_IMAGE=second-worker",
    );
    expect(imageOf(fake.runs()[0])).toBe(
      expectedImage(DOCKERFILE, "sha256:second-1", "owner/second"),
    );
  });

  it("Dockerfile と基本イメージが変わらなければ、ビルドし直さない", async () => {
    const fake = fakeDocker();
    const launcher = launcherWith(fake.docker);
    await launcher.run(REQUEST);
    const second = await launcher.run(REQUEST);
    const third = await launcher.run({
      ...REQUEST,
      workspace: "preflight",
      issue: undefined,
    });

    expect(second).toMatchObject({ ok: true, result: { build: "cached" } });
    expect(third).toMatchObject({ ok: true, result: { build: "cached" } });
    expect(fake.builds()).toHaveLength(1);
    expect(fake.runs().map(imageOf)).toEqual([
      expectedImage(),
      expectedImage(),
      expectedImage(),
    ]);
    // 起動係を起動し直しても(状態を持たなくても)、手元のイメージを見て決める。
    const restarted = await launcherWith(fake.docker).run(REQUEST);
    expect(restarted).toMatchObject({ ok: true, result: { build: "cached" } });
    expect(fake.builds()).toHaveLength(1);
  });

  it("Dockerfile が変わるとビルドし直し、同じ製品の古いイメージを消す", async () => {
    const fake = fakeDocker();
    const launcher = launcherWith(fake.docker);
    await launcher.run(REQUEST);
    const changed = `${DOCKERFILE}RUN true\n`;
    const response = await launcher.run({ ...REQUEST, dockerfile: changed });

    expect(response).toMatchObject({ ok: true, result: { build: "built" } });
    expect(fake.builds()).toHaveLength(2);
    expect(imageOf(fake.runs()[1])).toBe(expectedImage(changed));
    expect(fake.removals()).toEqual([expectedImage()]);
    expect(fake.built).toEqual([expectedImage(changed)]);
    // 片付けは、このファクトリーの、この製品のイメージだけを探す。
    const listed = fake.calls.find(
      (call) => call.args[0] === "image" && call.args[1] === "ls",
    );
    expect(listed?.args).toEqual([
      "image",
      "ls",
      "--filter=label=factory.built=factory-work",
      "--filter=label=factory.repo=owner/first",
      "--format={{.Repository}}:{{.Tag}}",
    ]);
  });

  it("基本イメージが作り直されると、ビルドし直す", async () => {
    const fake = fakeDocker();
    const launcher = launcherWith(fake.docker);
    await launcher.run(REQUEST);
    fake.images.set("factory-worker", "sha256:base-2");
    const response = await launcher.run(REQUEST);

    expect(response).toMatchObject({ ok: true, result: { build: "built" } });
    expect(fake.builds()).toHaveLength(2);
    expect(imageOf(fake.runs()[1])).toBe(
      expectedImage(DOCKERFILE, "sha256:base-2"),
    );
  });

  it("使用中で消せない古いイメージがあっても、失敗させない", async () => {
    const fake = fakeDocker({ inUse: [expectedImage()] });
    const { logger, records } = recorder();
    const launcher = launcherWith(fake.docker, { logger });
    await launcher.run(REQUEST);
    const response = await launcher.run({
      ...REQUEST,
      dockerfile: `${DOCKERFILE}RUN true\n`,
    });
    expect(response).toMatchObject({ ok: true, result: { build: "built" } });
    expect(records).toContainEqual({
      level: "warn",
      event: "launcher.image_cleanup_failed",
      fields: { repo: "owner/first", image: expectedImage() },
    });
  });

  it("同じイメージのビルドが重なったら、1つにまとめる", async () => {
    let finish: (result: CommandResult) => void = () => {};
    const fake = fakeDocker({
      onBuild: () =>
        new Promise<CommandResult>((resolve) => {
          finish = resolve;
        }),
    });
    const launcher = launcherWith(fake.docker);
    const first = launcher.run(REQUEST);
    const second = launcher.run({ ...REQUEST, issue: 13 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.builds()).toHaveLength(1);
    finish(ok());
    expect(await first).toMatchObject({ ok: true, result: { build: "built" } });
    expect(await second).toMatchObject({
      ok: true,
      result: { build: "built" },
    });
    expect(fake.builds()).toHaveLength(1);
    expect(fake.runs()).toHaveLength(2);
  });

  describe("ビルドできなかった場合", () => {
    it("検査に通らない Dockerfile は、ビルドせず、コマンドも実行しない", async () => {
      const fake = fakeDocker();
      const { logger, records } = recorder();
      const response = await launcherWith(fake.docker, { logger }).run({
        ...REQUEST,
        dockerfile: `${DOCKERFILE}ADD https://example.invalid/tool /tool\n`,
      });
      expect(response).toEqual({
        ok: true,
        result: {
          exit_code: null,
          timed_out: false,
          stdout: "",
          stderr:
            "Dockerfile を使えません(4行目): ADD は使えません(ビルドコンテキストは渡されません。取得は RUN で行ってください)",
          truncated: false,
          build: "failed",
        },
      });
      expect(fake.calls).toEqual([]);
      expect(records.map((record) => record.event)).toEqual([
        "launcher.build_rejected",
      ]);
    });

    it("ビルドに失敗したら、出力を返し、コマンドを実行しない", async () => {
      const fake = fakeDocker({
        onBuild: () => ({
          exitCode: 1,
          stdout: "Step 3/3 : RUN example-install\n",
          stderr: "example-install: not found\n",
          truncated: false,
        }),
      });
      const response = await launcherWith(fake.docker).run(REQUEST);
      expect(response).toMatchObject({
        ok: true,
        result: { exit_code: 1, timed_out: false, stdout: "", build: "failed" },
      });
      if (response.ok) {
        expect(response.result.stderr).toContain(
          "イメージのビルドに失敗しました",
        );
        expect(response.result.stderr).toContain(
          "Step 3/3 : RUN example-install",
        );
        expect(response.result.stderr).toContain("example-install: not found");
      }
      expect(fake.runs()).toEqual([]);
      expect(fake.removals()).toEqual([]);
      // 次の依頼では、もう一度ビルドを試す(失敗を覚えない)。
      await launcherWith(fake.docker).run(REQUEST);
      expect(fake.builds()).toHaveLength(2);
    });

    it("基本イメージが手元になければ、ビルドせずに、その旨を返す", async () => {
      const fake = fakeDocker();
      fake.images.delete("factory-worker");
      const response = await launcherWith(fake.docker).run(REQUEST);
      expect(response).toMatchObject({
        ok: true,
        result: { exit_code: null, build: "failed" },
      });
      if (response.ok) {
        expect(response.result.stderr).toContain(
          "基本イメージが手元にありません: factory-worker",
        );
      }
      expect(fake.builds()).toEqual([]);
      expect(fake.runs()).toEqual([]);
    });

    it("時間の上限を過ぎたら、ビルドを止めて、時間切れとして返す", async () => {
      let fire: () => void = () => {};
      let stopped = false;
      const fake = fakeDocker({
        onBuild: (call) =>
          new Promise<CommandResult>((resolve) => {
            call.options.signal?.addEventListener("abort", () => {
              stopped = true;
              resolve(failed("", 143));
            });
          }),
      });
      const launcher = launcherWith(fake.docker, {
        setTimer: (callback, ms) => {
          if (ms === BUILD_TIMEOUT_SEC * 1000) {
            fire = callback;
            return () => {};
          }
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      });
      const pending = launcher.run(REQUEST);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(false);
      fire();
      const response = await pending;
      expect(stopped).toBe(true);
      expect(response).toMatchObject({
        ok: true,
        result: { exit_code: 143, timed_out: true, build: "failed" },
      });
      if (response.ok) {
        expect(response.result.stderr).toContain("時間の上限");
      }
      expect(fake.runs()).toEqual([]);
    });

    it("dockerを起動できなければ、原因の分かる失敗として返す", async () => {
      const docker: Docker = {
        async exec() {
          throw new Error("docker を起動できません");
        },
      };
      const response = await launcherWith(docker).run(REQUEST);
      expect(response).toMatchObject({
        ok: true,
        result: { exit_code: null, build: "failed" },
      });
      if (response.ok) {
        expect(response.result.stderr).toContain("docker を起動できません");
      }
    });
  });

  it("ビルドの間に依頼した側がいなくなったら、コンテナを立てない", async () => {
    const abandoned = new AbortController();
    const fake = fakeDocker({
      onBuild: () => {
        abandoned.abort();
        return ok();
      },
    });
    const response = await launcherWith(fake.docker).run(
      REQUEST,
      abandoned.signal,
    );
    expect(response).toEqual({
      ok: false,
      error: "依頼した側がいなくなりました",
    });
    expect(fake.runs()).toEqual([]);
  });

  it("停止のときに、途中のビルドを止める", async () => {
    let stopped = false;
    const fake = fakeDocker({
      onBuild: (call) =>
        new Promise<CommandResult>((resolve) => {
          call.options.signal?.addEventListener("abort", () => {
            stopped = true;
            resolve(failed("", 143));
          });
        }),
    });
    const launcher = launcherWith(fake.docker);
    const pending = launcher.run(REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await launcher.stopAll();
    expect(stopped).toBe(true);
    expect(await pending).toMatchObject({
      ok: true,
      result: { build: "failed" },
    });
    expect(fake.runs()).toEqual([]);
  });

  it("ログに、Dockerfile の本文と、ビルドの出力を出さない", async () => {
    const fake = fakeDocker({
      onBuild: () => ({
        exitCode: 1,
        stdout: "secret-build-output",
        stderr: "",
        truncated: false,
      }),
    });
    const { logger, records } = recorder();
    await launcherWith(fake.docker, { logger }).run({
      ...REQUEST,
      dockerfile: `${DOCKERFILE}RUN echo secret-dockerfile-line\n`,
    });
    const text = JSON.stringify(records);
    expect(text).not.toContain("secret-dockerfile-line");
    expect(text).not.toContain("secret-build-output");
    expect(records.map((record) => record.event)).toEqual([
      "launcher.build_started",
      "launcher.build_finished",
    ]);
  });
});

describe("起動時の、旧ビルダーの確認", () => {
  it("基本イメージだけの Dockerfile を、ワーカーのネットワークでビルドしてみる", async () => {
    const fake = fakeDocker();
    expect(await launcherWith(fake.docker).checkBuilder()).toBe(true);
    const [build] = fake.builds();
    expect(build?.args).toEqual([
      "build",
      "--network=factory-workers",
      "--build-arg=FACTORY_BASE_IMAGE=factory-worker",
      "-",
    ]);
    expect(build?.options.stdin).toBe(BUILDER_PROBE_DOCKERFILE);
    expect(checkDockerfile(BUILDER_PROBE_DOCKERFILE)).toEqual({ ok: true });
    expect(build?.options.env).toMatchObject({ DOCKER_BUILDKIT: "0" });
    // 名前を付けないので、新しいイメージはできない。
    expect(fake.built).toEqual([]);
  });

  it("通らなければ、ログに出して、止まらない", async () => {
    const fake = fakeDocker({
      onBuild: () => failed("network mode not supported"),
    });
    const { logger, records } = recorder();
    expect(await launcherWith(fake.docker, { logger }).checkBuilder()).toBe(
      false,
    );
    expect(records).toEqual([
      {
        level: "warn",
        event: "launcher.builder_unavailable",
        fields: {
          network: "factory-workers",
          exit_code: 1,
          error: "network mode not supported",
        },
      },
    ]);
  });

  it("基本イメージが手元になければ、試さない", async () => {
    const fake = fakeDocker();
    fake.images.delete("factory-worker");
    expect(await launcherWith(fake.docker).checkBuilder()).toBeNull();
    expect(fake.builds()).toEqual([]);
  });
});
