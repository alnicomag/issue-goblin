import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, gitInvocation } from "../src/office/git.ts";
import { makeRepo, makeTempDir, plainGit, plantHooks } from "./git-fixtures.ts";

const IDENTITY = [
  "-c",
  "user.name=Example",
  "-c",
  "user.email=example@example.invalid",
];

describe("gitの引数と環境変数", () => {
  it("フックと、設定から起動されるコマンドを無効にする", () => {
    const { args } = gitInvocation(["status"]);
    expect(args).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "status",
    ]);
  });

  it("事務局の環境変数を引き継がず、システムとユーザーの設定を読まない", () => {
    const { env } = gitInvocation(["status"], {}, "/usr/bin");
    expect(env).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
  });

  it("トークンは環境変数で、その取得元にだけ渡す。引数には入れない", () => {
    const url = "https://git.example.invalid/owner/name.git";
    const { args, env } = gitInvocation(["fetch", url], {
      auth: { url, token: "dummy-token-value" },
    });
    expect(args.join(" ")).not.toContain("dummy-token-value");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe(`http.${url}.extraHeader`);
    const header = env.GIT_CONFIG_VALUE_0 ?? "";
    expect(header.startsWith("Authorization: Basic ")).toBe(true);
    expect(
      Buffer.from(
        header.slice("Authorization: Basic ".length),
        "base64",
      ).toString(),
    ).toBe("x-access-token:dummy-token-value");
  });

  it("HTTPSでない取得元には、トークンを渡さない", () => {
    for (const url of ["/srv/example.git", "http://git.example.invalid/x"]) {
      const { args, env } = gitInvocation(["fetch", url], {
        auth: { url, token: "dummy-token-value" },
      });
      expect(JSON.stringify([args, env])).not.toContain("dummy-token-value");
      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    }
  });

  it("改行を含むトークンは通さない", () => {
    const url = "https://git.example.invalid/owner/name.git";
    expect(() =>
      gitInvocation(["fetch", url], { auth: { url, token: "a\nb" } }),
    ).toThrow("改行");
  });
});

describe("フックを仕込んだリポジトリでのgitの実行", () => {
  let tmp: string;
  let repo: string;
  let marker: string;
  const git = createGit();

  const fired = (): string[] =>
    fs.existsSync(marker)
      ? [...new Set(fs.readFileSync(marker, "utf8").trim().split("\n"))].sort()
      : [];

  /** フックが動くはずの操作を一通り行う。 */
  const exercise = async (
    run: (...args: string[]) => Promise<unknown> | unknown,
    branch: string,
  ) => {
    await run("checkout", "--quiet", "-b", branch);
    fs.writeFileSync(path.join(repo, `${branch}.txt`), "x\n");
    await run("add", "--", `${branch}.txt`);
    await run("status", "--porcelain");
    await run(...IDENTITY, "commit", "--quiet", "-m", "example");
    await run("checkout", "--quiet", "main");
  };

  beforeEach(() => {
    tmp = makeTempDir();
    repo = makeRepo(path.join(tmp, "repo"));
    marker = path.join(tmp, "hook-fired");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("`.git/hooks` に置かれたフックが動かない", async () => {
    plantHooks(path.join(repo, ".git", "hooks"), marker);

    // 守りを付けないgitでは動くことを、先に確かめる(テストが空振りしていないこと)。
    await exercise((...args) => plainGit(repo, ...args), "plain");
    expect(fired()).toEqual(
      expect.arrayContaining(["pre-commit", "post-commit", "post-checkout"]),
    );
    fs.rmSync(marker);

    await exercise((...args) => git.run(args, { cwd: repo }), "guarded");
    expect(fired()).toEqual([]);
    // 操作そのものは行われている。
    expect(plainGit(repo, "log", "--format=%s", "-1", "guarded")).toBe(
      "example",
    );
  });

  it("リポジトリの設定でフックの場所やfsmonitorを指定されても、動かない", async () => {
    const hooksDir = path.join(tmp, "planted-hooks");
    plantHooks(hooksDir, marker);
    plainGit(repo, "config", "core.hooksPath", hooksDir);
    plainGit(
      repo,
      "config",
      "core.fsmonitor",
      path.join(hooksDir, "fsmonitor"),
    );

    await exercise((...args) => plainGit(repo, ...args), "plain");
    expect(fired()).toEqual(
      expect.arrayContaining(["pre-commit", "post-checkout", "fsmonitor"]),
    );
    fs.rmSync(marker);

    await exercise((...args) => git.run(args, { cwd: repo }), "guarded");
    expect(fired()).toEqual([]);
  });

  it("失敗したら、コマンドと理由の分かるメッセージで失敗する", async () => {
    await expect(
      git.run(["rev-parse", "--verify", "no-such-ref"], { cwd: repo }),
    ).rejects.toThrow(/git rev-parse --verify no-such-ref に失敗しました/);
  });

  it("事務局の環境変数が、gitに渡らない", async () => {
    process.env.FACTORY_TEST_SECRET = "dummy-secret-value";
    try {
      // エイリアスは、gitが起動するシェルの環境変数をそのまま出す。
      const output = await git.run(["-c", "alias.env=!env", "env"], {
        cwd: repo,
      });
      expect(output).not.toContain("dummy-secret-value");
      expect(output).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    } finally {
      delete process.env.FACTORY_TEST_SECRET;
    }
  });
});
