import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit } from "../src/office/git.ts";
import { importCommits, inspectChanges } from "../src/office/publish.ts";
import {
  prepareWorkspace,
  updateMirror,
  type WorkspaceDirs,
  type WorkspacePaths,
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
const ISSUE = 7;
const BRANCH = "agent/issue-7";
const AUTHOR = { name: "Example Worker", email: "worker@example.invalid" };

describe("取り込みと差分の検査", () => {
  let tmp: string;
  let source: string;
  let dirs: WorkspaceDirs;
  let paths: WorkspacePaths;
  let marker: string;
  const git = createGit();

  const fired = (): string[] =>
    fs.existsSync(marker)
      ? [...new Set(fs.readFileSync(marker, "utf8").trim().split("\n"))].sort()
      : [];

  const mirrorHead = () =>
    plainGit(paths.mirrorDir, "rev-parse", `refs/heads/${BRANCH}`);

  const inspect = () =>
    inspectChanges(git, {
      mirrorDir: paths.mirrorDir,
      branch: BRANCH,
      defaultBranch: "main",
    });

  beforeEach(async () => {
    tmp = makeTempDir();
    marker = path.join(tmp, "hook-fired");
    source = makeRepo(path.join(tmp, "source"));
    dirs = {
      reposDir: path.join(tmp, "data", "repos"),
      workDir: path.join(tmp, "work"),
    };
    paths = workspacePaths(dirs, REPO, ISSUE);
    await prepareWorkspace(
      { git },
      {
        dirs,
        repo: REPO,
        issue: ISSUE,
        source: { url: source },
        author: AUTHOR,
      },
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("ワーカーのコミットをミラーに取り込み、先頭のコミットを返す", async () => {
    const commit = commitFile(paths.repoDir, "feature.txt", "feature\n");

    expect(await importCommits(git, paths)).toBe(commit);
    expect(mirrorHead()).toBe(commit);
    // やり直しても同じ。
    expect(await importCommits(git, paths)).toBe(commit);
    // 作業場所のパスを、ミラーに残さない。
    const leaked = fs
      .readdirSync(paths.mirrorDir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => fs.readFileSync(file).includes(dirs.workDir));
    expect(leaked).toEqual([]);
    expect(plainGit(paths.mirrorDir, "remote")).toBe("");
  });

  it("履歴が書き換えられていても、作業場所の今の状態を取り込む", async () => {
    commitFile(paths.repoDir, "feature.txt", "feature\n");
    await importCommits(git, paths);
    plainGit(paths.repoDir, "commit", "--quiet", "--amend", "-m", "rewritten");
    const rewritten = plainGit(paths.repoDir, "rev-parse", "HEAD");

    expect(await importCommits(git, paths)).toBe(rewritten);
    expect(mirrorHead()).toBe(rewritten);
  });

  it("作業場所にブランチがなければ、null を返す", async () => {
    plainGit(paths.repoDir, "checkout", "--quiet", "--detach");
    plainGit(paths.repoDir, "branch", "--quiet", "-D", BRANCH);
    expect(await importCommits(git, paths)).toBeNull();
  });

  it("作業場所やミラーがなければ、失敗する", async () => {
    const missing = workspacePaths(dirs, REPO, 99);
    await expect(importCommits(git, missing)).rejects.toThrow(
      "作業場所がgitのリポジトリではありません",
    );
    fs.rmSync(paths.mirrorDir, { recursive: true });
    await expect(importCommits(git, paths)).rejects.toThrow(
      "ミラーがありません",
    );
  });

  describe("細工された作業場所", () => {
    it("作業場所の側のフックとgit設定が、取り込みと検査で効かない", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      const planted = path.join(tmp, "planted");
      plantHooks(path.join(paths.repoDir, ".git", "hooks"), marker);
      plantHooks(planted, marker);
      const script = (name: string) => {
        const file = path.join(planted, name);
        fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> '${marker}'\n`, {
          mode: 0o755,
        });
        return file;
      };
      for (const [key, value] of [
        ["core.fsmonitor", path.join(planted, "fsmonitor")],
        ["uploadpack.packObjectsHook", script("pack-objects-hook")],
        ["credential.helper", `!${script("credential-helper")}`],
        ["core.sshCommand", script("ssh-command")],
        ["core.pager", script("pager")],
        ["core.editor", script("editor")],
        ["diff.external", script("diff-external")],
        ["remote.origin.url", `ext::${script("remote-ext")}`],
        ["url.ext::false.insteadOf", paths.mirrorDir],
      ] as const) {
        plainGit(paths.repoDir, "config", key, value);
      }

      // 仕込みが生きていることを、守りを付けないgitで先に確かめる(テストが空振りしていないこと)。
      plainGit(paths.repoDir, "status", "--porcelain");
      plainGit(
        paths.repoDir,
        "commit",
        "--quiet",
        "--allow-empty",
        "--amend",
        "--no-edit",
      );
      expect(fired()).toEqual(
        expect.arrayContaining(["fsmonitor", "pre-commit", "post-commit"]),
      );
      fs.rmSync(marker);
      const amended = plainGit(paths.repoDir, "rev-parse", "HEAD");

      expect(await importCommits(git, paths)).toBe(amended);
      const changes = await inspect();

      expect(fired()).toEqual([]);
      expect(mirrorHead()).toBe(amended);
      expect(changes.paths).toEqual(["feature.txt"]);
      // 作業場所の設定は、ミラーに写らない。
      const mirrorConfig = fs.readFileSync(
        path.join(paths.mirrorDir, "config"),
        "utf8",
      );
      expect(mirrorConfig).not.toContain("planted");
      expect(mirrorConfig).not.toContain("ext::");
    });

    it("`.git` がリンクや別の場所を指すファイルなら、たどらずに失敗する", async () => {
      const other = makeRepo(path.join(tmp, "other"));
      plainGit(other, "checkout", "--quiet", "-b", BRANCH);
      commitFile(other, "planted.txt", "planted\n");
      const dotGit = path.join(paths.repoDir, ".git");

      fs.renameSync(dotGit, path.join(tmp, "moved.git"));
      fs.symlinkSync(path.join(other, ".git"), dotGit);
      await expect(importCommits(git, paths)).rejects.toThrow(
        "作業場所がgitのリポジトリではありません",
      );

      fs.rmSync(dotGit);
      fs.writeFileSync(dotGit, `gitdir: ${path.join(other, ".git")}\n`);
      await expect(importCommits(git, paths)).rejects.toThrow(
        "作業場所がgitのリポジトリではありません",
      );
      expect(plainGit(paths.mirrorDir, "for-each-ref", "refs/heads/")).toBe("");
    });

    it("`repo` がリンクなら、たどらずに失敗する", async () => {
      const other = makeRepo(path.join(tmp, "other"));
      fs.renameSync(paths.repoDir, path.join(tmp, "moved"));
      fs.symlinkSync(other, paths.repoDir);
      await expect(importCommits(git, paths)).rejects.toThrow(
        "作業場所がgitのリポジトリではありません",
      );
    });
  });

  describe("差分", () => {
    it("コミットがなければ、数は0で、パスは空", async () => {
      const head = await importCommits(git, paths);
      const changes = await inspect();
      expect(changes).toEqual({
        headCommit: head,
        mergeBase: head,
        commitCount: 0,
        paths: [],
      });
    });

    it("変更、追加、削除したパスを返す。改名は元と先の両方を返す", async () => {
      const base = plainGit(paths.repoDir, "rev-parse", "HEAD");
      fs.mkdirSync(path.join(paths.repoDir, "docs"));
      commitFile(paths.repoDir, "docs/名前 with space.md", "text\n");
      commitFile(paths.repoDir, "added.txt", "added\n");
      plainGit(paths.repoDir, "mv", "README.txt", "RENAMED.txt");
      plainGit(paths.repoDir, "commit", "--quiet", "-m", "rename");
      const head = await importCommits(git, paths);

      const changes = await inspect();
      expect(changes).toMatchObject({
        headCommit: head,
        mergeBase: base,
        commitCount: 3,
      });
      expect([...changes.paths].sort()).toEqual([
        "README.txt",
        "RENAMED.txt",
        "added.txt",
        "docs/名前 with space.md",
      ]);
    });

    it("打ち消し合うコミットは、コミットはあるが、パスは空", async () => {
      commitFile(paths.repoDir, "temp.txt", "temp\n");
      plainGit(paths.repoDir, "rm", "--quiet", "temp.txt");
      plainGit(paths.repoDir, "commit", "--quiet", "-m", "remove");
      await importCommits(git, paths);

      const changes = await inspect();
      expect(changes.commitCount).toBe(2);
      expect(changes.paths).toEqual([]);
    });

    it("既定ブランチが先に進んでいても、作業用のブランチの変更だけを返す", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      commitFile(source, "upstream.txt", "upstream\n");
      await updateMirror(git, paths.mirrorDir, { url: source });
      await importCommits(git, paths);

      const changes = await inspect();
      expect(changes.commitCount).toBe(1);
      expect(changes.paths).toEqual(["feature.txt"]);
    });

    it("既定ブランチと履歴がつながっていなければ、失敗する", async () => {
      plainGit(paths.repoDir, "checkout", "--quiet", "--orphan", "unrelated");
      commitFile(paths.repoDir, "unrelated.txt", "unrelated\n");
      plainGit(paths.repoDir, "branch", "--quiet", "--force", BRANCH);
      await importCommits(git, paths);

      await expect(inspect()).rejects.toThrow("履歴がつながっていません");
    });
  });
});
