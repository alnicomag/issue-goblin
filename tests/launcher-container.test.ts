import { describe, expect, it } from "vitest";
import {
  buildRunArgs,
  type ContainerSettings,
  issueDirFor,
  workerEnv,
} from "../src/launcher/container.ts";
import {
  MAX_ARGV_BYTES,
  MAX_STDIN_BYTES,
  MAX_TIMEOUT_SEC,
  parseRunRequest,
  type RunRequest,
} from "../src/launcher/request.ts";

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

const REQUEST: RunRequest = {
  repo: "owner/name",
  issue: 12,
  argv: ["sh", "-c", "echo hello"],
  stdin: "",
  claude_token: false,
  timeout_sec: 60,
};

describe("起動係への依頼の検査", () => {
  it("正常な依頼を読み、省略した項目に既定値を入れる", () => {
    const result = parseRunRequest({
      repo: "owner/name",
      issue: 12,
      argv: ["true"],
      timeout_sec: 60,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        repo: "owner/name",
        issue: 12,
        argv: ["true"],
        stdin: "",
        claude_token: false,
        timeout_sec: 60,
      },
    });
  });

  it("決まっていない項目のある依頼は拒否する", () => {
    // マウント、イメージ、ネットワーク、権限、環境変数は、依頼では指定できない。
    for (const extra of [
      { mounts: ["/:/host"] },
      { image: "other-image" },
      { network: "host" },
      { privileged: true },
      { env: { GITHUB_TOKEN: "x" } },
      { workdir: "/" },
      { user: "0:0" },
    ]) {
      const result = parseRunRequest({ ...REQUEST, ...extra });
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("形式に合わない依頼は、項目名の分かるメッセージで拒否する", () => {
    const cases: Array<[unknown, string]> = [
      [null, "(全体)"],
      ["run", "(全体)"],
      [{ ...REQUEST, repo: "owner" }, "repo"],
      [{ ...REQUEST, repo: "owner/name/extra" }, "repo"],
      [{ ...REQUEST, repo: "../../etc" }, "repo"],
      [{ ...REQUEST, repo: "owner/na me" }, "repo"],
      [{ ...REQUEST, issue: 0 }, "issue"],
      [{ ...REQUEST, issue: -1 }, "issue"],
      [{ ...REQUEST, issue: 1.5 }, "issue"],
      [{ ...REQUEST, issue: "12" }, "issue"],
      [{ ...REQUEST, issue: "../12" }, "issue"],
      [{ ...REQUEST, argv: [] }, "argv"],
      [{ ...REQUEST, argv: "echo hello" }, "argv"],
      [{ ...REQUEST, argv: ["a\0b"] }, "argv"],
      [{ ...REQUEST, argv: ["x".repeat(MAX_ARGV_BYTES)] }, "argv"],
      [{ ...REQUEST, stdin: "x".repeat(MAX_STDIN_BYTES + 1) }, "stdin"],
      [{ ...REQUEST, claude_token: "yes" }, "claude_token"],
      [{ ...REQUEST, timeout_sec: 0 }, "timeout_sec"],
      [{ ...REQUEST, timeout_sec: MAX_TIMEOUT_SEC + 1 }, "timeout_sec"],
    ];
    for (const [raw, where] of cases) {
      const result = parseRunRequest(raw);
      expect(result.ok, JSON.stringify(raw)?.slice(0, 80)).toBe(false);
      if (!result.ok) expect(result.error).toContain(where);
    }
  });
});

describe("作業場所のパス", () => {
  it("リポジトリとイシュー番号から決まる", () => {
    expect(issueDirFor("owner/name", 12)).toBe("owner/name/issue-12");
    expect(issueDirFor("Owner-1/.github", 3)).toBe("Owner-1/.github/issue-3");
  });

  it("リポジトリごと、イシューごとに分かれる", () => {
    const dirs = new Set([
      issueDirFor("owner/first", 1),
      issueDirFor("owner/first", 2),
      issueDirFor("owner/second", 1),
    ]);
    expect(dirs.size).toBe(3);
  });

  it("置き場所の外に出る名前は拒否する", () => {
    for (const repo of [
      "../name",
      "owner/..",
      "./name",
      "owner/.",
      "..",
      "owner",
      "owner/name/extra",
      "/owner/name",
      "owner//name",
      "owner/na me",
      "owner/name,dst=/",
      "",
    ]) {
      expect(() => issueDirFor(repo, 1), repo).toThrow();
    }
    for (const issue of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => issueDirFor("owner/name", issue), String(issue)).toThrow();
    }
  });
});

describe("ワーカーのコンテナの引数", () => {
  const args = buildRunArgs({
    request: REQUEST,
    repo: "owner/name",
    image: "factory-worker",
    containerName: "factory-worker-abc123",
    settings: SETTINGS,
  });

  it("マウントは、そのイシューの作業場所だけである", () => {
    const mounts = args.filter(
      (arg) =>
        arg.startsWith("--mount") ||
        arg.startsWith("--volume") ||
        arg.startsWith("-v"),
    );
    expect(mounts).toEqual([
      "--mount=type=volume,src=factory-work,dst=/workspace,volume-subpath=owner/name/issue-12",
    ]);
  });

  it("権限を落とし、資源の上限を付け、外への経路がないネットワークにつなぐ", () => {
    for (const expected of [
      "--rm",
      "--pull=never",
      "--network=factory-workers",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--memory=2g",
      "--pids-limit=512",
      "--cpus=2",
      "--label=factory.worker=factory-work",
      "--name=factory-worker-abc123",
      "--workdir=/workspace/repo",
    ]) {
      expect(args, expected).toContain(expected);
    }
    for (const forbidden of ["--privileged", "--cap-add", "--network=host"]) {
      expect(
        args.some((arg) => arg.startsWith(forbidden)),
        forbidden,
      ).toBe(false);
    }
  });

  it("環境変数は、明示した一覧だけである", () => {
    const env = args.filter((arg) => arg.startsWith("--env"));
    expect(env).toEqual([
      "--env=HOME=/workspace/home",
      "--env=HTTPS_PROXY=http://proxy:3128",
      "--env=HTTP_PROXY=http://proxy:3128",
      "--env=https_proxy=http://proxy:3128",
      "--env=http_proxy=http://proxy:3128",
    ]);
    expect(args.some((arg) => arg.startsWith("--env-file"))).toBe(false);
  });

  it("Claudeのトークンは、頼まれたときだけ、名前だけを渡す(値を引数に書かない)", () => {
    expect(workerEnv(SETTINGS, { claudeToken: false })).not.toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
    const withToken = buildRunArgs({
      request: { ...REQUEST, claude_token: true },
      repo: "owner/name",
      image: "factory-worker",
      containerName: "factory-worker-abc123",
      settings: SETTINGS,
    });
    const tokenArgs = withToken.filter((arg) => arg.includes("CLAUDE"));
    expect(tokenArgs).toEqual(["--env=CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("依頼のコマンドは、イメージ名の後ろにそのまま並ぶ", () => {
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(args.slice(separator)).toEqual([
      "--",
      "factory-worker",
      "sh",
      "-c",
      "echo hello",
    ]);
  });

  it("オプションに見えるコマンドでも、コンテナの設定は変わらない", () => {
    const tricky = buildRunArgs({
      request: { ...REQUEST, argv: ["--privileged", "-v", "/:/host"] },
      repo: "owner/name",
      image: "factory-worker",
      containerName: "factory-worker-abc123",
      settings: SETTINGS,
    });
    const separator = tricky.indexOf("--");
    // docker のオプションとして解釈される部分には、依頼の値が入らない。
    expect(tricky.slice(0, separator)).toEqual(
      args.slice(0, args.indexOf("--")),
    );
    expect(tricky.slice(separator + 2)).toEqual([
      "--privileged",
      "-v",
      "/:/host",
    ]);
  });

  it("オプションに見えるイメージ名は拒否する", () => {
    expect(() =>
      buildRunArgs({
        request: REQUEST,
        repo: "owner/name",
        image: "--privileged",
        containerName: "factory-worker-abc123",
        settings: SETTINGS,
      }),
    ).toThrow("イメージ名が不正です");
  });
});
