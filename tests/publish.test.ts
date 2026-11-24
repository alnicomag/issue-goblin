import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { createGit, type Git } from "../src/office/git.ts";
import { FACTORY_MARKER } from "../src/office/github.ts";
import type { LogFields, Logger } from "../src/office/log.ts";
import { parseFactoryYml } from "../src/office/product.ts";
import {
  buildPrBody,
  buildPrTitle,
  importCommits,
  inspectChanges,
  listCommitIdentities,
  type PublishVerifySummary,
  publish,
  SUMMARY_LIMIT,
  SUMMARY_MISSING_NOTE,
  SUMMARY_TRUNCATED_NOTE,
  sanitizeSummary,
  WORKER_SECTIONS_NOTE,
} from "../src/office/publish.ts";
import {
  prepareWorkspace,
  updateMirror,
  type WorkspaceDirs,
  type WorkspacePaths,
  workspacePaths,
} from "../src/office/workspace.ts";
import { FakeGitHub, VALID_FACTORY_YML } from "./fake-github.ts";
import {
  commitFile,
  makeRepo,
  makeTempDir,
  PLAIN_IDENTITY,
  plainGit,
  plantHooks,
  unconfiguredGit,
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

describe("PRの内容", () => {
  const verify: PublishVerifySummary = {
    passed: true,
    commands: [
      { name: "setup", status: "passed", exitCode: 0 },
      { name: "test", status: "passed", exitCode: 0 },
      { name: "lint", status: "passed", exitCode: 0 },
    ],
  };

  const NO_SUMMARIES = { implementSummary: null, reviewSummary: null };

  it("承認された保護対象のパスは、事務局が確かめた前半に、コードとして書く", () => {
    const body = buildPrBody({
      issue: 7,
      verify,
      unverified: [],
      ...NO_SUMMARIES,
      approvedPaths: [
        { path: ".github/workflows/ci.yml", pattern: ".github/**" },
        { path: "a/`@someone`\n<!-- factory -->", pattern: "a/**" },
      ],
    });
    const section = body.slice(
      body.indexOf("## 承認された保護対象のパス"),
      body.indexOf(WORKER_SECTIONS_NOTE),
    );
    expect(body.indexOf("## 承認された保護対象のパス")).toBeGreaterThan(
      body.indexOf("## 未検証の範囲"),
    );
    expect(section).toContain(
      "- `.github/workflows/ci.yml`(パターン: `.github/**`)",
    );
    expect(section).toContain("- `a/'@someone' ＜!-- factory -->`");
    expect(section).not.toContain("<!--");
  });

  it("承認されたパスがなければ、その節を書かない", () => {
    for (const approvedPaths of [undefined, []]) {
      const body = buildPrBody({
        issue: 7,
        verify,
        unverified: [],
        ...NO_SUMMARIES,
        ...(approvedPaths === undefined ? {} : { approvedPaths }),
      });
      expect(body).not.toContain("承認された");
    }
  });
  const IMPLEMENT = "### 変更の内容\n\nADDED A FEATURE\n\n### 未検証\n\nなし";
  const REVIEW =
    "### 受け入れ条件ごとの判定\n\n| 条件 | 判定 | 根拠 |\n| --- | --- | --- |\n| a | 満たす | JUDGED |\n\n### 提案\n\nなし";
  const build = (implementSummary: string | null, reviewSummary = REVIEW) =>
    buildPrBody({
      issue: 7,
      verify,
      unverified: ["example of an unverifiable area"],
      implementSummary,
      reviewSummary,
    });
  /** 本文の骨組み。`Closes`、節の見出し、目印を、出てくる順に挙げる。 */
  const skeleton = (body: string) =>
    body
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("Closes ") ||
          line.startsWith("## ") ||
          line === WORKER_SECTIONS_NOTE ||
          line === FACTORY_MARKER,
      );
  const SKELETON = [
    "Closes #7",
    "## 検証結果",
    "## 未検証の範囲",
    WORKER_SECTIONS_NOTE,
    "## 実装の要約(ワーカーの申告)",
    "## レビューの結果(ワーカーの申告)",
    FACTORY_MARKER,
  ];

  describe("ワーカーの要約", () => {
    it("implement と review の要約を、申告と分かる見出しの節に載せる", () => {
      const body = build(IMPLEMENT);
      expect(skeleton(body)).toEqual(SKELETON);
      expect(body).toContain(`## 実装の要約(ワーカーの申告)\n\n${IMPLEMENT}\n`);
      expect(body).toContain(
        `## レビューの結果(ワーカーの申告)\n\n${REVIEW}\n`,
      );
    });

    it("事務局が確かめた検査結果の表は、ワーカーの節より前にあり、区切られている", () => {
      const body = build(IMPLEMENT);
      const [office, worker] = body.split(`\n---\n\n${WORKER_SECTIONS_NOTE}\n`);
      expect(office).toContain("| `test` | 合格 | 0 |");
      expect(office).toContain("- example of an unverifiable area");
      expect(office).not.toContain("ADDED A FEATURE");
      expect(worker).toContain("ADDED A FEATURE");
      expect(worker).toContain("JUDGED");
      expect(worker).not.toContain("| `test` |");
    });

    it("要約がなければ、節を残して、ないと書く", () => {
      for (const missing of [null, "", " \n "]) {
        const body = buildPrBody({
          issue: 7,
          verify,
          unverified: [],
          implementSummary: missing,
          reviewSummary: missing,
        });
        expect(skeleton(body)).toEqual(SKELETON);
        expect(body).toContain(
          `## 実装の要約(ワーカーの申告)\n\n${SUMMARY_MISSING_NOTE}\n`,
        );
        expect(body).toContain(
          `## レビューの結果(ワーカーの申告)\n\n${SUMMARY_MISSING_NOTE}\n`,
        );
      }
    });

    it("同じ入力なら、同じ本文になる", () => {
      expect(build(IMPLEMENT)).toBe(build(IMPLEMENT));
    });

    it("長すぎる要約は、行の区切りで切り、省略したと書く", () => {
      const line = `${"x".repeat(99)}\n`;
      const long = line.repeat(500);
      const section = sanitizeSummary(long);
      expect(section.endsWith(`\n\n${SUMMARY_TRUNCATED_NOTE}`)).toBe(true);
      const kept = section.slice(0, -`\n\n${SUMMARY_TRUNCATED_NOTE}`.length);
      expect(kept.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
      expect(kept.length).toBeGreaterThan(SUMMARY_LIMIT - 200);
      // 行の途中では切らない。
      expect(kept.split("\n").every((entry) => entry.length === 99)).toBe(true);
      // 2つとも上限いっぱいでも、GitHubの本文の上限(65536文字)に収まる。
      const body = build(long, long);
      expect(body.length).toBeLessThan(65_536);
      expect(skeleton(body)).toEqual(SKELETON);
    });

    it("上限ちょうどの要約は切らない。改行のない長い要約は、上限で切る", () => {
      const exact = "y".repeat(SUMMARY_LIMIT);
      expect(sanitizeSummary(exact)).toBe(exact);
      expect(sanitizeSummary(`${exact}y`)).toBe(
        `${exact}\n\n${SUMMARY_TRUNCATED_NOTE}`,
      );
      // サロゲートペアの途中では切らない。
      const emoji = `${"y".repeat(SUMMARY_LIMIT - 1)}\u{1F600}`;
      expect(sanitizeSummary(emoji)).toBe(
        `${"y".repeat(SUMMARY_LIMIT - 1)}\n\n${SUMMARY_TRUNCATED_NOTE}`,
      );
    });

    it("切ったところがコードブロックの中なら、閉じてから省略を書く", () => {
      const long = `前置き\n\n\`\`\`\n${"code line\n".repeat(3000)}\`\`\`\n`;
      const section = sanitizeSummary(long);
      expect(
        section.endsWith(`code line\n\`\`\`\n\n${SUMMARY_TRUNCATED_NOTE}`),
      ).toBe(true);
    });

    it("閉じていないコードブロックを閉じて、後ろの節と目印を巻き込ませない", () => {
      expect(sanitizeSummary("a\n```js\ncode")).toBe("a\n```js\ncode\n```");
      expect(sanitizeSummary("a\n~~~~\ncode\n~~~")).toBe(
        "a\n~~~~\ncode\n~~~\n~~~~",
      );
      // 閉じているものには、何も足さない。
      for (const closed of [
        "a\n```js\ncode\n```\nb",
        "a\n````\n```\n````\nb",
        "行の中の ``` は数えない",
      ]) {
        expect(sanitizeSummary(closed)).toBe(closed);
      }
      const body = build("```\nunclosed");
      expect(body).toContain(
        "```\nunclosed\n```\n\n## レビューの結果(ワーカーの申告)",
      );
    });

    it("要約に目印やHTMLコメントがあっても、本文の目印は末尾の1つだけである", () => {
      const body = build(
        `before ${FACTORY_MARKER} after\n<!-- 閉じないコメント`,
        `${FACTORY_MARKER}\n<!--`,
      );
      expect(body.split(FACTORY_MARKER)).toHaveLength(2);
      expect(body.trimEnd().endsWith(FACTORY_MARKER)).toBe(true);
      expect(body.match(/<!--/g)).toHaveLength(1);
      expect(body).toContain("before \uFF1C!-- factory --> after");
      expect(skeleton(body)).toEqual(SKELETON);
    });

    it("要約にイシューを閉じる書き方があっても、閉じるのは対応イシューだけである", () => {
      const body = build(
        [
          "Closes #99",
          "fixes: #100 and Resolved owner/name#101",
          "closed https://github.com/owner/name/issues/102",
          "FIX #103",
          "see #104",
        ].join("\n"),
      );
      const closing =
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:[\w.-]+\/[\w.-]+)?(?:#\d+|https?:\/\/\S+)/gi;
      expect(body.match(closing)).toEqual(["Closes #7"]);
      expect(body.split("\n")[0]).toBe("Closes #7");
      expect(body).toContain("Closes \uFF0399");
      expect(body).toContain(
        "fixes: \uFF03100 and Resolved owner/name\uFF03101",
      );
      expect(body).toContain(
        "closed https\uFF1A//github.com/owner/name/issues/102",
      );
      expect(body).toContain("FIX \uFF03103");
      // 閉じる書き方でない参照は、そのままにする。
      expect(body).toContain("see #104");
    });

    it("要約のメンションを、通知が飛ばない形にする", () => {
      const body = build("cc @someone, (@owner/team) と @a-b。\n@first");
      expect(body.match(/(?<![A-Za-z0-9_])@[A-Za-z0-9]/g)).toBeNull();
      expect(body).toContain(
        "cc \uFF20someone, (\uFF20owner/team) と \uFF20a-b。\n\uFF20first",
      );
      // メールアドレスのような、語の途中の @ は変えない。
      expect(sanitizeSummary("mail a@example.invalid")).toBe(
        "mail a@example.invalid",
      );
    });

    it("トークンの形をした文字列を、ログと同じ伏せ方で伏せる", () => {
      const body = build(
        "token sk-ant-oat01-AAAAbbbb_cccc-dddd here",
        "also sk-ant-api03-ZZZZ",
      );
      expect(body).not.toMatch(/sk-ant-(?!\*\*\*)/);
      expect(body).toContain("token sk-ant-*** here");
      expect(body).toContain("also sk-ant-***");
    });

    it("要約の前後の空白と、改行の書き方をそろえる", () => {
      expect(sanitizeSummary("\n\n a\r\nb\rc \n")).toBe("a\nb\nc");
    });
  });

  it("対応イシュー、検証結果、未検証の範囲を書き、目印を付ける", () => {
    const body = buildPrBody({
      issue: 7,
      verify,
      unverified: ["example of an unverifiable area", "another\narea"],
      ...NO_SUMMARIES,
    });
    expect(body.split("\n")[0]).toBe("Closes #7");
    expect(body).toContain("すべて通りました");
    expect(body).toContain("| `setup` | 合格 | 0 |");
    expect(body).toContain("| `lint` | 合格 | 0 |");
    expect(body).toContain("## 未検証の範囲");
    expect(body).toContain("- example of an unverifiable area");
    // 改行で箇条書きを崩させない。
    expect(body).toContain("- another area");
    expect(body.trimEnd().endsWith(FACTORY_MARKER)).toBe(true);
  });

  it("通らなかった検査と、実行しなかった検査が分かる", () => {
    const body = buildPrBody({
      issue: 7,
      verify: {
        passed: false,
        commands: [
          { name: "setup", status: "passed", exitCode: 0 },
          { name: "test", status: "failed", exitCode: 2 },
          { name: "lint", status: "timed_out", exitCode: null },
        ],
      },
      unverified: [],
      ...NO_SUMMARIES,
    });
    expect(body).toContain("通らなかったものがあります");
    expect(body).toContain("| `test` | 不合格 | 2 |");
    expect(body).toContain("| `lint` | 時間切れ | - |");
    expect(body).toContain("## 未検証の範囲\n\nなし");
  });

  it("検証結果がなければ、ないと書く", () => {
    const body = buildPrBody({
      issue: 7,
      verify: null,
      unverified: [],
      ...NO_SUMMARIES,
    });
    expect(body).toContain("検証結果の記録がありません");
  });

  it("タイトルは、イシューのタイトルを1行にしたもの。空なら番号から作る", () => {
    expect(buildPrTitle(7, "  Add a\nfeature ")).toBe("Add a feature");
    expect(buildPrTitle(7, " \n")).toBe("Issue #7");
  });
});

describe("publish", () => {
  const TOKEN = "dummy-token-value";
  /**
   * ワーカーのコミットの作者(設定の `commit_author` に当たる)。
   * このテストでは、ワーカーのコミットを `plainGit` で作るので、その作者に合わせる。
   */
  const WORKER = PLAIN_IDENTITY;
  /** 取得元にもとからあるコミットの作者。ワーカーの作者とは別にする。 */
  const UPSTREAM = {
    name: "Upstream Person",
    email: "upstream@example.invalid",
  };
  const OTHER = { name: "Someone Else", email: "someone@example.invalid" };
  const VERIFY: PublishVerifySummary = {
    passed: true,
    commands: [{ name: "test", status: "passed", exitCode: 0 }],
  };

  let tmp: string;
  let source: string;
  let dirs: WorkspaceDirs;
  let paths: WorkspacePaths;
  let db: Db;
  let fake: FakeGitHub;
  let logs: { level: string; event: string; fields: LogFields }[];
  let logger: Logger;
  let gitCalls: (readonly string[])[];
  let git: Git;

  const run = (
    dryRun: boolean,
    issueTitle = "Example issue",
    approvedCommit: string | null = null,
  ) =>
    publish(
      { db, git, write: { api: fake, dryRun, logger }, dirs },
      {
        repo: REPO,
        issue: ISSUE,
        issueTitle,
        source: { url: source, token: TOKEN },
        author: WORKER,
        verify: VERIFY,
        implementSummary: "IMPLEMENT SUMMARY",
        reviewSummary: "REVIEW SUMMARY sk-ant-oat01-SECRETsecret",
        approvedCommit,
      },
    );

  /** push 先(GitHubの代わり)にある、作業用のブランチの先頭。なければ null。 */
  const remoteHead = (): string | null => {
    const out = plainGit(
      source,
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/${BRANCH}`,
    );
    return out === "" ? null : out;
  };

  /** 作者とコミッターを指定して、空のコミットを作り、そのハッシュを返す。 */
  const commitAs = (
    repoDir: string,
    author: { name: string; email: string },
    committer: { name: string; email: string } = author,
  ): string => {
    plainGit(
      repoDir,
      "-c",
      `user.name=${committer.name}`,
      "-c",
      `user.email=${committer.email}`,
      "commit",
      "--quiet",
      "--allow-empty",
      `--author=${author.name} <${author.email}>`,
      "-m",
      "empty",
    );
    return plainGit(repoDir, "rev-parse", "HEAD");
  };

  const pushCalls = () => gitCalls.filter((args) => args.includes("push"));
  const skippedActions = () =>
    logs
      .filter((line) => line.event === "github.write_skipped")
      .map((line) => line.fields.action);

  const setFactoryYml = (text: string) => {
    const parsed = parseFactoryYml(text);
    if (!parsed.ok) throw new Error(parsed.errors);
    db.prepare("UPDATE repos SET factory_yml = ? WHERE repo = ?").run(
      JSON.stringify(parsed.value),
      REPO,
    );
  };

  beforeEach(async () => {
    tmp = makeTempDir();
    source = makeRepo(path.join(tmp, "source"));
    commitAs(source, UPSTREAM);
    dirs = {
      reposDir: path.join(tmp, "data", "repos"),
      workDir: path.join(tmp, "work"),
    };
    paths = workspacePaths(dirs, REPO, ISSUE);
    db = openDb(path.join(tmp, "data", "factory.db"));
    migrate(db, { clock: { now: () => new Date("2026-03-01T01:00:00.000Z") } });
    db.prepare(
      "INSERT INTO repos (repo, factory_yml, factory_yml_sha) VALUES (?, NULL, ?)",
    ).run(REPO, "sha-1");
    setFactoryYml(VALID_FACTORY_YML);
    fake = new FakeGitHub();
    logs = [];
    const push =
      (level: string) =>
      (event: string, fields: LogFields = {}) => {
        logs.push({ level, event, fields });
      };
    logger = { info: push("info"), warn: push("warn"), error: push("error") };
    const real = createGit();
    gitCalls = [];
    git = {
      run(args, options) {
        gitCalls.push(args);
        return real.run(args, options);
      },
    };
    await prepareWorkspace(
      { git: real },
      {
        dirs,
        repo: REPO,
        issue: ISSUE,
        source: { url: source },
        author: WORKER,
      },
    );
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** push もPRの書き込みも、行われていないこと。 */
  const expectNothingWritten = () => {
    expect(pushCalls()).toEqual([]);
    expect(remoteHead()).toBeNull();
    expect(fake.writes).toEqual([]);
    expect(fake.pullRequests).toEqual([]);
  };

  it("検査を通った変更を push し、PRを作る", async () => {
    const commit = commitFile(paths.repoDir, "feature.txt", "feature\n");

    const result = await run(false);

    expect(result).toMatchObject({
      status: "published",
      outcome: "done",
      awaitingApproval: false,
      branch: BRANCH,
      baseBranch: "main",
      headCommit: commit,
      changedPaths: ["feature.txt"],
      forbidden: [],
      protected: [],
      prNumber: 100,
      prCreated: true,
    });
    expect(remoteHead()).toBe(commit);
    expect(fake.pullRequests).toHaveLength(1);
    expect(fake.pullRequests[0]).toMatchObject({
      head: BRANCH,
      base: "main",
      title: "Example issue",
    });
    const body = fake.pullRequests[0]?.body ?? "";
    expect(body).toContain("Closes #7");
    expect(body).toContain("| `test` | 合格 | 0 |");
    expect(body).toContain("- example of an unverifiable area");
    expect(body).toContain(FACTORY_MARKER);
    expect(body).toContain(
      "## 実装の要約(ワーカーの申告)\n\nIMPLEMENT SUMMARY\n",
    );
    expect(body).toContain(
      "## レビューの結果(ワーカーの申告)\n\nREVIEW SUMMARY sk-ant-***\n",
    );
    expect(JSON.stringify(fake.calls)).not.toContain("SECRETsecret");
  });

  it("push するのは作業用のブランチだけで、既定ブランチは変わらない(マージしない)", async () => {
    const mainBefore = plainGit(source, "rev-parse", "refs/heads/main");
    commitFile(paths.repoDir, "feature.txt", "feature\n");

    await run(false);

    expect(pushCalls()).toHaveLength(1);
    expect(pushCalls()[0]?.at(-1)).toBe(
      `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
    );
    expect(plainGit(source, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(
      plainGit(source, "for-each-ref", "--format=%(refname)").split("\n"),
    ).toEqual([`refs/heads/${BRANCH}`, "refs/heads/main"]);
    expect(fake.writes.map((call) => call.method)).toEqual([
      "createPullRequest",
    ]);
  });

  describe("やり直し", () => {
    it("同じブランチのPRがすでにあれば更新し、2つ作らない", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      const first = await run(false);
      const second = await run(false, "Renamed issue");

      expect(first.prCreated).toBe(true);
      expect(second).toMatchObject({
        status: "published",
        outcome: "done",
        prNumber: first.prNumber,
        prCreated: false,
      });
      expect(fake.pullRequests).toHaveLength(1);
      expect(fake.pullRequests[0]?.title).toBe("Renamed issue");
      // 同じ入力でやり直すと、本文は同じ内容になる。
      const [created, updated] = fake.writes;
      expect(
        updated?.method === "updatePullRequest" ? updated.content.body : null,
      ).toBe(
        created?.method === "createPullRequest"
          ? created.input.body
          : undefined,
      );
      expect(fake.writes.map((call) => call.method)).toEqual([
        "createPullRequest",
        "updatePullRequest",
      ]);
    });

    it("差し戻しでコミットが増えたり、履歴が変わったりしても、同じPRのまま push し直す", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      await run(false);

      plainGit(paths.repoDir, "commit", "--quiet", "--amend", "-m", "redo");
      const added = commitFile(paths.repoDir, "more.txt", "more\n");
      const result = await run(false);

      expect(result).toMatchObject({ status: "published", prCreated: false });
      expect([...result.changedPaths].sort()).toEqual([
        "feature.txt",
        "more.txt",
      ]);
      expect(remoteHead()).toBe(added);
      expect(fake.pullRequests).toHaveLength(1);
    });

    it("push の後、PRを作る前に落ちた場合も、次の呼び出しでPRを1つ作る", async () => {
      const commit = commitFile(paths.repoDir, "feature.txt", "feature\n");
      fake.failWritesWith = new Error("temporary failure");
      await expect(run(false)).rejects.toThrow("temporary failure");
      expect(remoteHead()).toBe(commit);
      expect(fake.pullRequests).toEqual([]);

      fake.failWritesWith = null;
      const result = await run(false);
      expect(result).toMatchObject({ status: "published", prCreated: true });
      expect(fake.pullRequests).toHaveLength(1);
    });
  });

  it("dry_run なら、要約があっても、GitHubへの書き込みを1回も行わない", async () => {
    commitFile(paths.repoDir, "feature.txt", "feature\n");
    const result = await run(true);
    expect(result).toMatchObject({ status: "dry_run", outcome: "done" });
    expectNothingWritten();
  });

  describe("PRを作らずに失敗として扱う場合", () => {
    it("コミットがない", async () => {
      const result = await run(false);
      expect(result).toMatchObject({
        status: "no_commits",
        outcome: "failed",
        awaitingApproval: false,
        prNumber: null,
      });
      expectNothingWritten();
    });

    it("ブランチがない", async () => {
      plainGit(paths.repoDir, "checkout", "--quiet", "--detach");
      plainGit(paths.repoDir, "branch", "--quiet", "-D", BRANCH);
      const result = await run(false);
      expect(result).toMatchObject({
        status: "no_commits",
        outcome: "failed",
        headCommit: null,
      });
      expectNothingWritten();
    });

    it("コミットはあるが、差分が空", async () => {
      commitFile(paths.repoDir, "temp.txt", "temp\n");
      plainGit(paths.repoDir, "rm", "--quiet", "temp.txt");
      plainGit(paths.repoDir, "commit", "--quiet", "-m", "remove");

      const result = await run(false);
      expect(result).toMatchObject({ status: "empty_diff", outcome: "failed" });
      expectNothingWritten();
    });

    it("paths.forbidden に当たる変更がある", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      fs.mkdirSync(path.join(paths.repoDir, "generated"));
      commitFile(paths.repoDir, "generated/out.txt", "out\n");

      const result = await run(false);
      expect(result).toMatchObject({
        status: "forbidden",
        outcome: "held",
        awaitingApproval: false,
        forbidden: [{ path: "generated/out.txt", pattern: "generated/**" }],
        protected: [],
      });
      expect(result.summary).toContain("generated/out.txt");
      expectNothingWritten();
    });

    it("改名で禁止のパスから持ち出した場合も、止める", async () => {
      fs.mkdirSync(path.join(source, "generated"));
      commitFile(source, "generated/out.txt", "a long enough content\n");
      fs.rmSync(paths.issueDir, { recursive: true });
      await prepareWorkspace(
        { git },
        {
          dirs,
          repo: REPO,
          issue: ISSUE,
          source: { url: source },
          author: WORKER,
        },
      );
      gitCalls.length = 0;
      plainGit(paths.repoDir, "mv", "generated/out.txt", "moved.txt");
      plainGit(paths.repoDir, "commit", "--quiet", "-m", "move");

      const result = await run(false);
      expect(result.status).toBe("forbidden");
      expect(result.forbidden.map((hit) => hit.path)).toEqual([
        "generated/out.txt",
      ]);
      expectNothingWritten();
    });
  });

  describe("コミットの作者", () => {
    const stoppedLog = () =>
      logs.find((line) => line.event === "publish.stopped")?.fields;

    it("取得元にもとからあるコミットの作者は検査しない", async () => {
      // 既定ブランチには、別の作者のコミットがある。作業場所を作った後に増えた分も含めて、検査しない。
      commitAs(source, OTHER);
      expect(
        plainGit(source, "log", "--format=%an", "main").split("\n"),
      ).toEqual([OTHER.name, UPSTREAM.name, WORKER.name]);
      commitFile(paths.repoDir, "feature.txt", "feature\n");

      const result = await run(false);
      expect(result).toMatchObject({
        status: "published",
        authorMismatches: [],
      });
    });

    it("作者だけが違うコミットがあれば、push もPRの作成もせず、ハッシュと作者を残す", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      const bad = commitAs(paths.repoDir, OTHER, WORKER);

      const result = await run(false);
      const mismatches = [{ commit: bad, author: OTHER, committer: WORKER }];
      expect(result).toMatchObject({
        status: "author_mismatch",
        outcome: "failed",
        awaitingApproval: false,
        headCommit: bad,
        prNumber: null,
      });
      expect(result.authorMismatches).toEqual(mismatches);
      expect(result.summary).toContain(bad.slice(0, 12));
      expect(result.summary).toContain(`${OTHER.name} <${OTHER.email}>`);
      expect(stoppedLog()).toMatchObject({
        status: "author_mismatch",
        author_mismatches: mismatches,
      });
      expectNothingWritten();
    });

    it("コミッターだけが違うコミットがあれば、止める", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      const bad = commitAs(paths.repoDir, WORKER, OTHER);

      const result = await run(false);
      expect(result.status).toBe("author_mismatch");
      expect(result.authorMismatches).toEqual([
        { commit: bad, author: WORKER, committer: OTHER },
      ]);
      expectNothingWritten();
    });

    it("複数のコミットのうち1つだけが違う場合も、止める", async () => {
      commitFile(paths.repoDir, "first.txt", "first\n");
      const bad = commitAs(paths.repoDir, {
        name: WORKER.name,
        email: OTHER.email,
      });
      commitFile(paths.repoDir, "last.txt", "last\n");

      const result = await run(false);
      expect(result.status).toBe("author_mismatch");
      expect(result.authorMismatches.map((entry) => entry.commit)).toEqual([
        bad,
      ]);
      expectNothingWritten();
    });

    it("差分が空でも、パスの検査で止まる変更でも、作者の不一致を先に報告する", async () => {
      commitAs(paths.repoDir, OTHER);
      expect((await run(false)).status).toBe("author_mismatch");

      fs.mkdirSync(path.join(paths.repoDir, "generated"));
      commitFile(paths.repoDir, "generated/out.txt", "out\n");
      expect((await run(false)).status).toBe("author_mismatch");
      expectNothingWritten();
    });

    it("dry_run でも同じ結果になる", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      commitAs(paths.repoDir, OTHER);

      const result = await run(true);
      expect(result.status).toBe("author_mismatch");
      expect(skippedActions()).toEqual([]);
    });

    describe("作業場所のgit設定をワーカーが書き換えた場合", () => {
      /** 作者を渡さずにコミットする。作者は、作業場所のgit設定で決まる。 */
      const commitWithRepoConfig = (name: string): string => {
        fs.writeFileSync(path.join(paths.repoDir, name), `${name}\n`);
        unconfiguredGit(paths.repoDir, "add", "--", name);
        unconfiguredGit(paths.repoDir, "commit", "--quiet", "-m", name);
        return plainGit(paths.repoDir, "rev-parse", "HEAD");
      };
      const setRepoConfig = (identity: { name: string; email: string }) => {
        plainGit(paths.repoDir, "config", "user.name", identity.name);
        plainGit(paths.repoDir, "config", "user.email", identity.email);
      };

      it("書き換えた設定で作ったコミットは、止める", async () => {
        setRepoConfig(OTHER);
        const bad = commitWithRepoConfig("feature.txt");

        const result = await run(false);
        expect(result.status).toBe("author_mismatch");
        expect(result.authorMismatches).toEqual([
          { commit: bad, author: OTHER, committer: OTHER },
        ]);
        expectNothingWritten();
      });

      it("別の作者でコミットした後に設定を元に戻しても、止める", async () => {
        setRepoConfig(OTHER);
        const bad = commitWithRepoConfig("feature.txt");
        setRepoConfig(WORKER);

        const result = await run(false);
        expect(result.authorMismatches.map((entry) => entry.commit)).toEqual([
          bad,
        ]);
        expectNothingWritten();
      });

      it("正しい作者でコミットした後に設定を書き換えても、通る", async () => {
        const commit = commitWithRepoConfig("feature.txt");
        setRepoConfig(OTHER);

        const result = await run(false);
        expect(result).toMatchObject({
          status: "published",
          headCommit: commit,
        });
        expect(remoteHead()).toBe(commit);
      });

      it("設定はそのままで、環境変数で作者を変えたコミットは、止める", async () => {
        fs.writeFileSync(path.join(paths.repoDir, "feature.txt"), "feature\n");
        plainGit(paths.repoDir, "add", "--", "feature.txt");
        execFileSync("git", ["commit", "--quiet", "-m", "feature"], {
          cwd: paths.repoDir,
          env: {
            PATH: process.env.PATH ?? "",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: OTHER.name,
            GIT_AUTHOR_EMAIL: OTHER.email,
            GIT_COMMITTER_NAME: OTHER.name,
            GIT_COMMITTER_EMAIL: OTHER.email,
          },
        });

        const result = await run(false);
        expect(result.status).toBe("author_mismatch");
        expect(result.authorMismatches).toMatchObject([
          { author: OTHER, committer: OTHER },
        ]);
        expectNothingWritten();
      });
    });

    it("読めたコミットの数が合わなければ、失敗する", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      await importCommits(git, paths);
      const list = (expectedCount: number) =>
        listCommitIdentities(git, {
          mirrorDir: paths.mirrorDir,
          branch: BRANCH,
          defaultBranch: "main",
          expectedCount,
        });

      expect(await list(1)).toMatchObject([
        { author: WORKER, committer: WORKER },
      ]);
      await expect(list(2)).rejects.toThrow("コミットの作者を読めません");
    });
  });

  it("paths.protected に当たる変更は、push せずに、人間の承認待ちとして返す", async () => {
    commitFile(paths.repoDir, "feature.txt", "feature\n");
    fs.mkdirSync(path.join(paths.repoDir, "docs"));
    commitFile(paths.repoDir, "docs/guide.md", "guide\n");

    const result = await run(false);
    expect(result).toMatchObject({
      status: "needs_approval",
      outcome: "held",
      awaitingApproval: true,
      forbidden: [],
      protected: [{ path: "docs/guide.md", pattern: "docs/**" }],
    });
    expect(result.summary).toContain("人間の承認待ち");
    expectNothingWritten();
    expect(logs.at(-1)).toMatchObject({
      level: "warn",
      event: "publish.stopped",
      fields: { status: "needs_approval" },
    });
  });

  describe("承認待ちで止まったときの、保護対象のパスの差分", () => {
    const protectedFile = (name: string, content: string): string => {
      fs.mkdirSync(path.join(paths.repoDir, "docs"), { recursive: true });
      return commitFile(paths.repoDir, `docs/${name}`, content);
    };

    it("止まったコミットの、保護対象のパスの差分だけを、結果に入れる", async () => {
      commitFile(paths.repoDir, "feature.txt", "unprotected change\n");
      protectedFile("guide.md", "first version\n");
      const head = protectedFile("guide.md", "second version\n");

      const result = await run(false);
      expect(result).toMatchObject({
        status: "needs_approval",
        headCommit: head,
      });
      const base = plainGit(paths.mirrorDir, "merge-base", "origin/main", head);
      expect(result.protectedDiff?.text).toBe(
        plainGit(
          paths.mirrorDir,
          "diff",
          "--no-renames",
          base,
          head,
          "--",
          "docs/guide.md",
        ),
      );
      expect(result.protectedDiff?.text).toContain("+second version");
      expect(result.protectedDiff?.text).not.toContain("first version");
      expect(result.protectedDiff?.text).not.toContain("unprotected change");
      expect(result.protectedDiff).toMatchObject({
        truncated: false,
        omittedPaths: 0,
      });
      expectNothingWritten();
    });

    it("パスは文字どおりに扱い、記号を含む名前でも、そのファイルの差分になる", async () => {
      protectedFile("*.md", "star\n");
      protectedFile("plain.md", "plain\n");
      const result = await run(false);
      expect(result.protectedDiff?.text).toContain("+star");
      expect(result.protectedDiff?.text?.match(/^\+plain$/gm)).toHaveLength(1);
    });

    it("トークンに見える文字列は、結果に入れる前に伏せる", async () => {
      protectedFile("guide.md", "key: sk-ant-example-value\n");
      const result = await run(false);
      expect(result.protectedDiff?.text).toContain("sk-ant-***");
      expect(JSON.stringify(result)).not.toContain("example-value");
    });

    it("長い差分は、上限で切り、全体の大きさを残す", async () => {
      const content = Array.from(
        { length: 6000 },
        (_, index) => `line ${index}\n`,
      ).join("");
      protectedFile("long.md", content);
      const result = await run(false);
      expect(result.protectedDiff?.truncated).toBe(true);
      expect(result.protectedDiff?.text?.length).toBeLessThanOrEqual(40_000);
      expect(result.protectedDiff?.totalChars).toBeGreaterThan(content.length);
      expect(result.protectedDiff?.totalLines).toBeGreaterThan(6000);
    });

    it("差分を取れなくても、失敗にせず、承認待ちで止める", async () => {
      protectedFile("guide.md", "guide\n");
      const inner = git;
      git = {
        run(args, options) {
          if (args.includes("--literal-pathspecs")) {
            return Promise.reject(
              new Error("stdout maxBuffer length exceeded"),
            );
          }
          return inner.run(args, options);
        },
      };
      const result = await run(false);
      expect(result).toMatchObject({
        status: "needs_approval",
        outcome: "held",
        protectedDiff: { text: null },
      });
      expect(
        logs.find((line) => line.event === "publish.diff_unavailable"),
      ).toMatchObject({ level: "warn" });
      expectNothingWritten();
    });

    it("forbidden で止まったときは、差分を取らない", async () => {
      fs.mkdirSync(path.join(paths.repoDir, "generated"));
      commitFile(paths.repoDir, "generated/out.txt", "out\n");
      const result = await run(false);
      expect(result.status).toBe("forbidden");
      expect(result.protectedDiff).toBeNull();
    });
  });

  describe("人間が承認したコミット", () => {
    const touchProtected = (): string => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      fs.mkdirSync(path.join(paths.repoDir, "docs"), { recursive: true });
      return commitFile(paths.repoDir, "docs/guide.md", "guide\n");
    };

    it("先頭が承認されたコミットなら、保護対象のパスに触れていても、push してPRを作る", async () => {
      const head = touchProtected();
      const result = await run(false, "Example issue", head);
      expect(result).toMatchObject({
        status: "published",
        outcome: "done",
        awaitingApproval: false,
        headCommit: head,
        protected: [{ path: "docs/guide.md", pattern: "docs/**" }],
        prNumber: 100,
      });
      expect(remoteHead()).toBe(head);
      const body = fake.pullRequests[0]?.body ?? "";
      expect(body).toContain("## 承認された保護対象のパス");
      expect(body).toContain("- `docs/guide.md`(パターン: `docs/**`)");
      expect(logs.at(-1)).toMatchObject({
        event: "publish.finished",
        fields: { approved_protected: 1 },
      });
    });

    it("承認の後にコミットが変わっていれば、承認は効かず、また止まる", async () => {
      const approved = touchProtected();
      const head = commitFile(paths.repoDir, "docs/more.md", "more\n");
      const result = await run(false, "Example issue", approved);
      expect(result).toMatchObject({
        status: "needs_approval",
        outcome: "held",
        headCommit: head,
      });
      expectNothingWritten();
    });

    it("承認されたコミットでも、paths.forbidden に当たる変更は通さない", async () => {
      touchProtected();
      fs.mkdirSync(path.join(paths.repoDir, "generated"));
      const head = commitFile(paths.repoDir, "generated/out.txt", "out\n");
      const result = await run(false, "Example issue", head);
      expect(result).toMatchObject({ status: "forbidden", outcome: "held" });
      expectNothingWritten();
    });

    it("承認されたコミットでも、作者の検査は緩まない", async () => {
      touchProtected();
      const head = commitAs(paths.repoDir, OTHER, WORKER);
      const result = await run(false, "Example issue", head);
      expect(result.status).toBe("author_mismatch");
      expectNothingWritten();
    });

    it("保護対象のパスに触れていなければ、PRの本文に承認の節を書かない", async () => {
      const head = commitFile(paths.repoDir, "feature.txt", "feature\n");
      const result = await run(false, "Example issue", head);
      expect(result.status).toBe("published");
      expect(fake.pullRequests[0]?.body).not.toContain("承認された");
    });
  });

  it("規則は、作業場所の factory.yml ではなく、保存済みのものから読む", async () => {
    // ワーカーが、作業場所の factory.yml で規則を外そうとする。
    commitFile(
      paths.repoDir,
      "factory.yml",
      VALID_FACTORY_YML.replace("- generated/**", "- nothing/**"),
    );
    fs.mkdirSync(path.join(paths.repoDir, "generated"));
    commitFile(paths.repoDir, "generated/out.txt", "out\n");

    const result = await run(false);
    expect(result.status).toBe("forbidden");
    expectNothingWritten();
  });

  describe("dry_run が true のとき", () => {
    it("push もPRの作成も行わず、予定だったことをログに出す", async () => {
      const commit = commitFile(paths.repoDir, "feature.txt", "feature\n");

      const result = await run(true);

      expect(result).toMatchObject({
        status: "dry_run",
        outcome: "done",
        headCommit: commit,
        changedPaths: ["feature.txt"],
        prNumber: null,
        prCreated: false,
      });
      expectNothingWritten();
      expect(skippedActions()).toEqual(["push", "create_pull_request"]);
      expect(logs.some((line) => line.event === "github.write")).toBe(false);
    });

    it("既存のPRがあっても更新せず、予定だったことをログに出す", async () => {
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      fake.pullRequests.push({
        number: 55,
        open: true,
        head: BRANCH,
        base: "main",
        title: "Old",
        body: "old",
      });

      const result = await run(true);

      expect(result).toMatchObject({
        status: "dry_run",
        prNumber: 55,
        prCreated: false,
      });
      expect(pushCalls()).toEqual([]);
      expect(fake.writes).toEqual([]);
      expect(fake.pullRequests[0]).toMatchObject({ title: "Old", body: "old" });
      expect(skippedActions()).toEqual(["push", "update_pull_request"]);
    });

    it("検査で止まる変更は、dry_run でも同じ結果になる", async () => {
      fs.mkdirSync(path.join(paths.repoDir, "docs"));
      commitFile(paths.repoDir, "docs/guide.md", "guide\n");
      const result = await run(true);
      expect(result.status).toBe("needs_approval");
      expect(skippedActions()).toEqual([]);
    });
  });

  describe("検査そのものを行えない場合", () => {
    it("factory.yml が保存されていなければ、gitを実行せずに失敗する", async () => {
      db.prepare("UPDATE repos SET factory_yml = NULL WHERE repo = ?").run(
        REPO,
      );
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      await expect(run(false)).rejects.toThrow("factory.yml が不正です");
      expect(gitCalls).toEqual([]);
      expectNothingWritten();
    });

    it("読めないパターンがあれば、gitを実行せずに失敗する", async () => {
      // 同期の検証は読めないパターンを保存しないので、検証が入る前に保存された内容を模して、直接書く。
      const parsed = parseFactoryYml(VALID_FACTORY_YML);
      if (!parsed.ok) throw new Error(parsed.errors);
      db.prepare("UPDATE repos SET factory_yml = ? WHERE repo = ?").run(
        JSON.stringify({
          ...parsed.value,
          paths: { protected: ["docs/[a-z]*.md"], forbidden: [] },
        }),
        REPO,
      );
      commitFile(paths.repoDir, "feature.txt", "feature\n");
      await expect(run(false)).rejects.toThrow("パスのパターンを読めません");
      expect(gitCalls).toEqual([]);
      expectNothingWritten();
    });

    it("作業場所がなければ、失敗する", async () => {
      fs.rmSync(paths.issueDir, { recursive: true });
      await expect(run(false)).rejects.toThrow(
        "作業場所がgitのリポジトリではありません",
      );
      expectNothingWritten();
    });
  });

  it("トークンが、gitの設定、引数、ログ、DB、作業場所、ミラーに残らない", async () => {
    commitFile(paths.repoDir, "feature.txt", "feature\n");
    const result = await run(false);
    expect(result.status).toBe("published");
    await run(false);
    db.pragma("wal_checkpoint(TRUNCATE)");

    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    for (const secret of [TOKEN, encoded]) {
      const files = fs
        .readdirSync(tmp, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      expect(files.length).toBeGreaterThan(10);
      expect(
        files.filter((file) => fs.readFileSync(file).includes(secret)),
      ).toEqual([]);
      expect(JSON.stringify(gitCalls)).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(fake.calls)).not.toContain(secret);
    }
    // ミラーにも作業場所にも、リモートを登録しない。
    expect(plainGit(paths.mirrorDir, "remote")).toBe("");
    expect(plainGit(paths.repoDir, "remote")).toBe("");
  });
});
