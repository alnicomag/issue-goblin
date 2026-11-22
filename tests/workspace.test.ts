import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git, type GitRunOptions } from "../src/office/git.ts";
import {
  branchFor,
  cleanupWorkspace,
  githubSourceUrl,
  prepareWorkspace,
  type WorkspaceDirs,
  workspacePaths,
} from "../src/office/workspace.ts";
import {
  commitFile,
  makeRepo,
  makeTempDir,
  plainGit,
  plantHooks,
} from "./git-fixtures.ts";

const REPO = "owner/name";
const TOKEN = "dummy-token-value";

/** 本物のgitに渡しつつ、呼び出しを記録する。 */
function recordingGit(): {
  git: Git;
  calls: { args: readonly string[]; options: GitRunOptions }[];
} {
  const real = createGit();
  const calls: { args: readonly string[]; options: GitRunOptions }[] = [];
  return {
    calls,
    git: {
      run(args, options = {}) {
        calls.push({ args, options });
        return real.run(args, options);
      },
    },
  };
}

/** ディレクトリの中の、すべてのファイル(シンボリックリンクはたどらない)。 */
function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** `needle` を含むファイル。 */
function filesContaining(dir: string, needle: string): string[] {
  return listFiles(dir).filter((file) =>
    fs.readFileSync(file).includes(needle),
  );
}

describe("作業場所", () => {
  let tmp: string;
  let source: string;
  let dirs: WorkspaceDirs;
  const git = createGit();

  const prepare = (issue: number, repo = REPO, url = source) =>
    prepareWorkspace({ git }, { dirs, repo, issue, source: { url } });

  beforeEach(() => {
    tmp = makeTempDir();
    source = makeRepo(path.join(tmp, "source"));
    dirs = {
      reposDir: path.join(tmp, "data", "repos"),
      workDir: path.join(tmp, "work"),
    };
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("prepare", () => {
    it("既定ブランチの最新から、ブランチと作業場所を作る", async () => {
      const tip = commitFile(source, "latest.txt", "latest\n");

      const workspace = await prepare(7);

      expect(workspace).toEqual({
        mirrorDir: path.join(dirs.reposDir, "owner", "name.git"),
        issueDir: path.join(dirs.workDir, "owner", "name", "issue-7"),
        repoDir: path.join(dirs.workDir, "owner", "name", "issue-7", "repo"),
        homeDir: path.join(dirs.workDir, "owner", "name", "issue-7", "home"),
        branch: "agent/issue-7",
        created: true,
      });
      const { repoDir } = workspace;
      expect(plainGit(repoDir, "symbolic-ref", "HEAD")).toBe(
        "refs/heads/agent/issue-7",
      );
      expect(plainGit(repoDir, "rev-parse", "agent/issue-7")).toBe(tip);
      // 差分の基準として、既定ブランチも手元に持つ。
      expect(plainGit(repoDir, "rev-parse", "main")).toBe(tip);
      expect(plainGit(repoDir, "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(repoDir, "latest.txt"), "utf8")).toBe(
        "latest\n",
      );
      expect(fs.statSync(workspace.homeDir).isDirectory()).toBe(true);
      expect(fs.readdirSync(workspace.issueDir).sort()).toEqual([
        "home",
        "repo",
      ]);
    });

    it("既定ブランチの名前が違っても、取得元の既定ブランチから作る", async () => {
      const other = makeRepo(path.join(tmp, "other-source"), "trunk");
      plainGit(other, "branch", "side");
      const tip = commitFile(other, "trunk.txt", "trunk\n");

      const { repoDir } = await prepare(1, "owner/other", other);

      expect(plainGit(repoDir, "rev-parse", "agent/issue-1")).toBe(tip);
      expect(plainGit(repoDir, "rev-parse", "trunk")).toBe(tip);
    });

    it("後から作る作業場所は、その時点の最新から始まる", async () => {
      await prepare(1);
      const tip = commitFile(source, "later.txt", "later\n");

      const { repoDir } = await prepare(2);

      expect(plainGit(repoDir, "rev-parse", "agent/issue-2")).toBe(tip);
    });

    it("取得元のタグも持つ", async () => {
      plainGit(source, "tag", "v1.0.0");
      const { repoDir } = await prepare(1);
      expect(plainGit(repoDir, "tag", "--list")).toBe("v1.0.0");
    });

    it("やり直しても、すでにある作業場所とブランチをそのまま使う", async () => {
      const first = await prepare(3);
      const work = commitFile(first.repoDir, "work.txt", "work\n");
      commitFile(source, "upstream.txt", "upstream\n");

      const second = await prepare(3);

      expect(second).toEqual({ ...first, created: false });
      expect(plainGit(second.repoDir, "rev-parse", "agent/issue-3")).toBe(work);
      expect(fs.existsSync(path.join(second.repoDir, "work.txt"))).toBe(true);
      expect(fs.existsSync(path.join(second.repoDir, "upstream.txt"))).toBe(
        false,
      );
    });

    it("すでにある作業場所を使うときは、取得元に触れない", async () => {
      await prepare(3);
      fs.rmSync(source, { recursive: true, force: true });
      await expect(prepare(3)).resolves.toMatchObject({ created: false });
    });

    it("途中で止まった後にやり直すと、作りかけを消して作り直す", async () => {
      // cloneの途中で失敗させる。
      const real = createGit();
      const failing: Git = {
        run(args, options) {
          if (args[0] === "reset") {
            return Promise.reject(new Error("interrupted"));
          }
          return real.run(args, options);
        },
      };
      await expect(
        prepareWorkspace(
          { git: failing },
          { dirs, repo: REPO, issue: 4, source: { url: source } },
        ),
      ).rejects.toThrow("interrupted");
      const paths = workspacePaths(dirs, REPO, 4);
      expect(fs.readdirSync(paths.issueDir)).toEqual(["repo.partial"]);

      const workspace = await prepare(4);

      expect(workspace.created).toBe(true);
      expect(fs.readdirSync(paths.issueDir).sort()).toEqual(["home", "repo"]);
      expect(plainGit(workspace.repoDir, "rev-parse", "agent/issue-4")).toBe(
        plainGit(source, "rev-parse", "main"),
      );
    });

    it("HOMEだけがない状態からやり直すと、HOMEを作る", async () => {
      const first = await prepare(5);
      fs.rmSync(first.homeDir, { recursive: true });
      const second = await prepare(5);
      expect(second.created).toBe(false);
      expect(fs.statSync(second.homeDir).isDirectory()).toBe(true);
    });

    it("作業場所がリンクに差し替えられていたら、たどらずに失敗する", async () => {
      const { repoDir, homeDir } = await prepare(6);
      const outside = makeRepo(path.join(tmp, "outside"));
      plainGit(outside, "branch", "agent/issue-6");

      fs.rmSync(repoDir, { recursive: true });
      fs.symlinkSync(outside, repoDir);
      await expect(prepare(6)).rejects.toThrow("ディレクトリではありません");

      fs.rmSync(repoDir);
      fs.rmSync(homeDir, { recursive: true });
      fs.symlinkSync(outside, homeDir);
      await expect(prepare(6)).rejects.toThrow("ディレクトリではありません");
    });

    it("作業場所の `.git` がディレクトリでなければ失敗する", async () => {
      const { repoDir } = await prepare(6);
      const outside = makeRepo(path.join(tmp, "outside"));
      plainGit(outside, "branch", "agent/issue-6");
      fs.rmSync(path.join(repoDir, ".git"), { recursive: true });

      await expect(prepare(6)).rejects.toThrow("gitのリポジトリではありません");

      fs.writeFileSync(
        path.join(repoDir, ".git"),
        `gitdir: ${path.join(outside, ".git")}\n`,
      );
      await expect(prepare(6)).rejects.toThrow("gitのリポジトリではありません");
    });

    it("作業場所からブランチが消されていたら、理由を出して失敗する", async () => {
      const { repoDir } = await prepare(8);
      plainGit(repoDir, "checkout", "--quiet", "main");
      plainGit(repoDir, "branch", "--quiet", "-D", "agent/issue-8");

      await expect(prepare(8)).rejects.toThrow(
        "ブランチ agent/issue-8 がありません",
      );
    });

    it("ワーカーが作業場所に仕込んだフックや設定は、やり直しのときに動かない", async () => {
      const { repoDir } = await prepare(9);
      const marker = path.join(tmp, "hook-fired");
      plantHooks(path.join(repoDir, ".git", "hooks"), marker);
      const planted = path.join(repoDir, "planted-hooks");
      plantHooks(planted, marker);
      plainGit(
        repoDir,
        "config",
        "core.fsmonitor",
        path.join(planted, "fsmonitor"),
      );

      await expect(prepare(9)).resolves.toMatchObject({ created: false });

      expect(fs.existsSync(marker)).toBe(false);
    });

    it("取得元に既定ブランチがなければ失敗する", async () => {
      const empty = path.join(tmp, "empty");
      fs.mkdirSync(empty);
      plainGit(empty, "init", "--quiet");
      await expect(prepare(1, "owner/empty", empty)).rejects.toThrow(
        "既定ブランチ",
      );
    });
  });

  describe("cleanup", () => {
    it("作業場所を消す。ミラーと、ほかのイシューの作業場所は残す", async () => {
      const target = await prepare(1);
      const other = await prepare(2);

      expect(cleanupWorkspace({ dirs, repo: REPO, issue: 1 })).toEqual({
        issueDir: target.issueDir,
      });

      expect(fs.existsSync(target.issueDir)).toBe(false);
      expect(fs.existsSync(other.repoDir)).toBe(true);
      expect(fs.existsSync(target.mirrorDir)).toBe(true);
    });

    it("すでになくても失敗しない", async () => {
      await prepare(1);
      cleanupWorkspace({ dirs, repo: REPO, issue: 1 });
      expect(() =>
        cleanupWorkspace({ dirs, repo: REPO, issue: 1 }),
      ).not.toThrow();
      // 一度も準備していないイシューでも同じ。
      expect(() =>
        cleanupWorkspace({ dirs, repo: "owner/never", issue: 99 }),
      ).not.toThrow();
    });

    it("消した後に prepare すると、最新から作り直す", async () => {
      const first = await prepare(1);
      commitFile(first.repoDir, "work.txt", "work\n");
      cleanupWorkspace({ dirs, repo: REPO, issue: 1 });
      const tip = commitFile(source, "upstream.txt", "upstream\n");

      const second = await prepare(1);

      expect(second.created).toBe(true);
      expect(plainGit(second.repoDir, "rev-parse", "agent/issue-1")).toBe(tip);
    });

    it("作業場所の中のリンクはたどらず、リンク先を消さない", async () => {
      const { issueDir, repoDir } = await prepare(1);
      const outside = path.join(tmp, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
      fs.symlinkSync(outside, path.join(repoDir, "link"));
      fs.rmSync(path.join(issueDir, "home"), { recursive: true });
      fs.symlinkSync(outside, path.join(issueDir, "home"));

      cleanupWorkspace({ dirs, repo: REPO, issue: 1 });

      expect(fs.existsSync(issueDir)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
    });
  });

  describe("資格情報と取得元", () => {
    it("作業場所に、トークンも取得元もミラーの場所も残らない", async () => {
      const { git: recording, calls } = recordingGit();

      const workspace = await prepareWorkspace(
        { git: recording },
        { dirs, repo: REPO, issue: 1, source: { url: source, token: TOKEN } },
      );

      for (const needle of [TOKEN, source, workspace.mirrorDir]) {
        expect(filesContaining(dirs.workDir, needle), needle).toEqual([]);
      }
      // 事務局の側(ミラー)にも、トークンを保存しない。
      expect(filesContaining(dirs.reposDir, TOKEN)).toEqual([]);
      // 探し方が空振りしていないこと。
      expect(
        filesContaining(dirs.workDir, "refs/heads/agent/issue-1"),
      ).not.toEqual([]);

      // トークンは引数に入れず、取得元と通信する呼び出しにだけ渡す。
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(
        TOKEN,
      );
      const withAuth = calls.filter((call) => call.options.auth !== undefined);
      expect(withAuth.map((call) => call.args[0])).toEqual([
        "fetch",
        "ls-remote",
      ]);
      for (const call of withAuth) {
        expect(call.options).toEqual({
          cwd: workspace.mirrorDir,
          auth: { url: source, token: TOKEN },
        });
        expect(call.args).toContain(source);
      }
    });

    it("作業場所のcloneに、リモートがない", async () => {
      const { repoDir } = await prepare(1);

      expect(plainGit(repoDir, "remote")).toBe("");
      expect(plainGit(repoDir, "config", "--local", "--list")).not.toMatch(
        /^(remote|url|branch)\./m,
      );
      expect(fs.existsSync(path.join(repoDir, ".git", "FETCH_HEAD"))).toBe(
        false,
      );
    });

    it("作業場所のcloneは、ミラーとファイルを共有しない", async () => {
      const { repoDir } = await prepare(1);
      const objects = path.join(repoDir, ".git", "objects");

      expect(fs.existsSync(path.join(objects, "info", "alternates"))).toBe(
        false,
      );
      const files = listFiles(objects);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(fs.statSync(file).nlink, file).toBe(1);
      }
    });

    it("ミラーにも、取得元をリモートとして残さない", async () => {
      const { mirrorDir } = await prepare(1);
      expect(plainGit(mirrorDir, "remote")).toBe("");
      expect(plainGit(mirrorDir, "rev-parse", "--is-bare-repository")).toBe(
        "true",
      );
    });

    it("GitHubの取得元は、トークンを含まないURLになる", () => {
      expect(githubSourceUrl("owner/name")).toBe(
        "https://github.com/owner/name.git",
      );
      expect(() => githubSourceUrl("owner/name/extra")).toThrow();
      expect(() => githubSourceUrl("user:pass@host/name")).toThrow();
    });
  });

  describe("複数のリポジトリ", () => {
    it("置き場所がリポジトリごとに分かれ、互いに触れない", async () => {
      const second = makeRepo(path.join(tmp, "second-source"));
      const secondTip = commitFile(second, "second.txt", "second\n");

      const a = await prepare(1, "owner/first", source);
      const b = await prepare(1, "owner/second", second);

      expect(a.mirrorDir).toBe(path.join(dirs.reposDir, "owner", "first.git"));
      expect(b.mirrorDir).toBe(path.join(dirs.reposDir, "owner", "second.git"));
      expect(a.issueDir).toBe(
        path.join(dirs.workDir, "owner", "first", "issue-1"),
      );
      expect(b.issueDir).toBe(
        path.join(dirs.workDir, "owner", "second", "issue-1"),
      );
      expect(plainGit(a.repoDir, "rev-parse", "agent/issue-1")).toBe(
        plainGit(source, "rev-parse", "main"),
      );
      expect(plainGit(b.repoDir, "rev-parse", "agent/issue-1")).toBe(secondTip);
      expect(fs.existsSync(path.join(a.repoDir, "second.txt"))).toBe(false);

      cleanupWorkspace({ dirs, repo: "owner/first", issue: 1 });

      expect(fs.existsSync(a.issueDir)).toBe(false);
      expect(fs.existsSync(b.repoDir)).toBe(true);
      expect(fs.existsSync(a.mirrorDir)).toBe(true);
    });
  });
});

describe("作業場所のパス", () => {
  const dirs = { reposDir: "/data/repos", workDir: "/work" };

  it("ミラーは作業場所の置き場所の外に、作業場所はその内側にできる", () => {
    expect(workspacePaths(dirs, "owner/name", 12)).toEqual({
      mirrorDir: "/data/repos/owner/name.git",
      issueDir: "/work/owner/name/issue-12",
      repoDir: "/work/owner/name/issue-12/repo",
      homeDir: "/work/owner/name/issue-12/home",
      branch: "agent/issue-12",
    });
  });

  it.each([
    "../name",
    "owner/..",
    "owner/.",
    "./name",
    "owner",
    "owner/name/extra",
    "owner/name/../../..",
    "/owner/name",
    "owner//name",
    "owner/na me",
    "owner/name\n",
    "owner\\..\\name/x y",
    "",
  ])("細工のあるリポジトリ名は通さない: %j", (repo) => {
    expect(() => workspacePaths(dirs, repo, 1)).toThrow();
    expect(() => cleanupWorkspace({ dirs, repo, issue: 1 })).toThrow();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    "1/../../x" as unknown as number,
    "7" as unknown as number,
  ])("細工のあるイシュー番号は通さない: %j", (issue) => {
    expect(() => workspacePaths(dirs, "owner/name", issue)).toThrow();
    expect(() =>
      cleanupWorkspace({ dirs, repo: "owner/name", issue }),
    ).toThrow();
    expect(() => branchFor(issue)).toThrow();
  });

  it.each([
    ["ミラーが作業場所の内側", { reposDir: "/work/repos", workDir: "/work" }],
    ["作業場所がミラーの内側", { reposDir: "/data", workDir: "/data/work" }],
    ["同じ場所", { reposDir: "/work", workDir: "/work/" }],
    ["相対パス", { reposDir: "repos", workDir: "/work" }],
  ])("置き場所の指定が不正なら失敗する: %s", (_name, bad) => {
    expect(() => workspacePaths(bad, "owner/name", 1)).toThrow("置き場所");
  });

  it("細工のある入力では、置き場所の外に何も作らず、何も消さない", async () => {
    const tmp = makeTempDir();
    try {
      const real = {
        reposDir: path.join(tmp, "repos"),
        workDir: path.join(tmp, "work"),
      };
      fs.writeFileSync(path.join(tmp, "keep.txt"), "keep\n");
      const git: Git = {
        run: () => Promise.reject(new Error("gitを実行してはいけない")),
      };
      await expect(
        prepareWorkspace(
          { git },
          { dirs: real, repo: "../..", issue: 1, source: { url: "/nowhere" } },
        ),
      ).rejects.toThrow("リポジトリ名");
      expect(() =>
        cleanupWorkspace({ dirs: real, repo: "owner/..", issue: 1 }),
      ).toThrow("リポジトリ名");
      expect(fs.readdirSync(tmp)).toEqual(["keep.txt"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
