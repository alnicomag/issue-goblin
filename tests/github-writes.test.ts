import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGit,
  type Git,
  type GitRunOptions,
  gitInvocation,
} from "../src/office/git.ts";
import {
  addIssueComment,
  createPullRequest,
  FACTORY_MARKER,
  pushBranch,
  removeLabel,
  setStateLabel,
  updatePullRequest,
  type WriteContext,
  withFactoryMarker,
} from "../src/office/github.ts";
import type { LogFields, Logger } from "../src/office/log.ts";
import { FakeGitHub } from "./fake-github.ts";
import { commitFile, makeRepo, makeTempDir, plainGit } from "./git-fixtures.ts";

const REPO = "owner/name";
const BRANCH = "agent/issue-7";
const TOKEN = "dummy-token-value";

interface LogLine {
  level: string;
  event: string;
  fields: LogFields;
}

function recordingLogger(): { logger: Logger; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const push =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      logs.push({ level, event, fields });
    };
  return {
    logs,
    logger: { info: push("info"), warn: push("warn"), error: push("error") },
  };
}

/** 呼び出しを記録するだけで、何も実行しないgit。 */
function fakeGit(): {
  git: Git;
  calls: { args: readonly string[]; options: GitRunOptions }[];
} {
  const calls: { args: readonly string[]; options: GitRunOptions }[] = [];
  return {
    calls,
    git: {
      run(args, options = {}) {
        calls.push({ args, options });
        return Promise.resolve("");
      },
    },
  };
}

describe("GitHubへの書き込み", () => {
  let fake: FakeGitHub;
  let logs: LogLine[];
  let ctx: (dryRun: boolean) => WriteContext;

  beforeEach(() => {
    fake = new FakeGitHub();
    const recorded = recordingLogger();
    logs = recorded.logs;
    ctx = (dryRun) => ({ api: fake, dryRun, logger: recorded.logger });
  });

  const skipped = () =>
    logs
      .filter((line) => line.event === "github.write_skipped")
      .map((line) => line.fields.action);

  describe("dry_run が true のとき", () => {
    it("push せず、予定だったことをログに出す", async () => {
      const { git, calls } = fakeGit();
      const pushed = await pushBranch(ctx(true), {
        git,
        mirrorDir: "/nowhere",
        repo: REPO,
        url: "https://github.invalid/owner/name.git",
        token: TOKEN,
        branch: BRANCH,
      });
      expect(pushed).toBe(false);
      expect(calls).toEqual([]);
      expect(logs).toEqual([
        {
          level: "info",
          event: "github.write_skipped",
          fields: {
            reason: "dry_run",
            action: "push",
            repo: REPO,
            branch: BRANCH,
          },
        },
      ]);
    });

    it("PRを作らず、更新もせず、予定だったことをログに出す", async () => {
      const created = await createPullRequest(ctx(true), REPO, {
        head: BRANCH,
        base: "main",
        title: "Example",
        body: "body",
      });
      const updated = await updatePullRequest(ctx(true), REPO, 5, {
        title: "Example",
        body: "body",
      });
      expect(created).toBeNull();
      expect(updated).toBe(false);
      expect(fake.calls).toEqual([]);
      expect(skipped()).toEqual(["create_pull_request", "update_pull_request"]);
      expect(logs[0]?.fields).toMatchObject({
        reason: "dry_run",
        repo: REPO,
        head: BRANCH,
        base: "main",
      });
    });

    it("コメントせず、予定だったことをログに出す", async () => {
      const commented = await addIssueComment(ctx(true), REPO, 7, "hello");
      expect(commented).toBe(false);
      expect(fake.calls).toEqual([]);
      expect(skipped()).toEqual(["add_issue_comment"]);
      expect(logs[0]?.fields).toMatchObject({
        reason: "dry_run",
        repo: REPO,
        issue: 7,
      });
    });
  });

  describe("状態のラベルの付け替え", () => {
    const T = "2026-03-01T00:00:00.000Z";
    const change = { from: "ready", to: "in-progress" } as const;

    it("dry_run が true なら、書き込まず、予定だったことをログに出す", async () => {
      fake.putIssue({ number: 7, labels: ["state:ready"], updatedAt: T });
      expect(await setStateLabel(ctx(true), REPO, 7, change)).toBe(false);
      expect(fake.calls).toEqual([]);
      expect(skipped()).toEqual(["set_state_label"]);
    });

    it("新しいラベルを付けてから、古いラベルを外す。ほかのラベルは残す", async () => {
      fake.putIssue({
        number: 7,
        labels: ["state:ready", "priority:p1"],
        updatedAt: T,
      });
      expect(await setStateLabel(ctx(false), REPO, 7, change)).toBe(true);
      expect(fake.writes.map((call) => call.method)).toEqual([
        "addLabels",
        "removeLabel",
      ]);
      expect(fake.issues[0]?.labels).toEqual([
        "priority:p1",
        "state:in-progress",
      ]);
    });

    it("2回行っても、同じ結果になる", async () => {
      fake.putIssue({ number: 7, labels: ["state:ready"], updatedAt: T });
      await setStateLabel(ctx(false), REPO, 7, change);
      await setStateLabel(ctx(false), REPO, 7, change);
      expect(fake.issues[0]?.labels).toEqual(["state:in-progress"]);
    });

    it("closed と、同じ状態への付け替えは、書き込まずに失敗する", async () => {
      await expect(
        setStateLabel(ctx(false), REPO, 7, { from: "in-review", to: "closed" }),
      ).rejects.toThrow(/closed/);
      await expect(
        setStateLabel(ctx(false), REPO, 7, { from: "ready", to: "ready" }),
      ).rejects.toThrow(/同じ状態/);
      expect(fake.calls).toEqual([]);
    });
  });

  describe("ラベルの取り外し", () => {
    it("dry_run が true なら、書き込まず、予定だったことをログに出す", async () => {
      fake.putIssue({
        number: 7,
        labels: ["agent:approved"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      expect(await removeLabel(ctx(true), REPO, 7, "agent:approved")).toBe(
        false,
      );
      expect(fake.calls).toEqual([]);
      expect(logs).toEqual([
        {
          level: "info",
          event: "github.write_skipped",
          fields: {
            reason: "dry_run",
            action: "remove_label",
            repo: REPO,
            issue: 7,
            label: "agent:approved",
          },
        },
      ]);
    });

    it("ラベルを外す。ほかのラベルは残す。2回行っても、同じ結果になる", async () => {
      fake.putIssue({
        number: 7,
        labels: ["state:needs-info", "agent:approved"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      expect(await removeLabel(ctx(false), REPO, 7, "agent:approved")).toBe(
        true,
      );
      expect(await removeLabel(ctx(false), REPO, 7, "agent:approved")).toBe(
        true,
      );
      expect(fake.issues[0]?.labels).toEqual(["state:needs-info"]);
    });

    it("状態のラベルは、書き込まずに失敗する", async () => {
      await expect(
        removeLabel(ctx(false), REPO, 7, "state:ready"),
      ).rejects.toThrow(/状態のラベル/);
      expect(fake.calls).toEqual([]);
    });
  });

  describe("dry_run が false のとき", () => {
    it("PRを作り、番号を返す", async () => {
      const created = await createPullRequest(ctx(false), REPO, {
        head: BRANCH,
        base: "main",
        title: "Example",
        body: "body",
      });
      expect(created?.number).toBe(100);
      expect(fake.pullRequests).toMatchObject([
        { head: BRANCH, base: "main", title: "Example", body: "body" },
      ]);
      expect(logs.map((line) => line.event)).toEqual(["github.write"]);
    });

    it("PRのタイトルと本文を更新する", async () => {
      await createPullRequest(ctx(false), REPO, {
        head: BRANCH,
        base: "main",
        title: "Old",
        body: "old",
      });
      const updated = await updatePullRequest(ctx(false), REPO, 100, {
        title: "New",
        body: "new",
      });
      expect(updated).toBe(true);
      expect(fake.pullRequests).toMatchObject([{ title: "New", body: "new" }]);
    });

    it("コメントには目印を付ける。本文はログに出さない", async () => {
      await addIssueComment(ctx(false), REPO, 7, "a private detail");
      expect(fake.comments.map((comment) => comment.body)).toEqual([
        `a private detail\n\n${FACTORY_MARKER}\n`,
      ]);
      expect(JSON.stringify(logs)).not.toContain("a private detail");
    });

    it("空のコメントは、書かずに失敗する", async () => {
      await expect(addIssueComment(ctx(false), REPO, 7, " \n")).rejects.toThrow(
        "空",
      );
      expect(fake.calls).toEqual([]);
    });
  });

  it("目印は、すでにあれば重ねて付けない", () => {
    const once = withFactoryMarker("text");
    expect(once).toBe(`text\n\n${FACTORY_MARKER}\n`);
    expect(withFactoryMarker(once)).toBe(once);
  });

  describe("push", () => {
    it("作業用のブランチ以外は、dry_run でも失敗する", async () => {
      const { git, calls } = fakeGit();
      for (const branch of [
        "main",
        "agent/issue-0",
        "agent/issue-7/x",
        "refs/heads/main",
        "agent/issue-7:refs/heads/main",
        "+agent/issue-7",
      ]) {
        for (const dryRun of [true, false]) {
          await expect(
            pushBranch(ctx(dryRun), {
              git,
              mirrorDir: "/nowhere",
              repo: REPO,
              url: "https://github.invalid/owner/name.git",
              branch,
            }),
          ).rejects.toThrow("作業用のブランチ");
        }
      }
      expect(calls).toEqual([]);
    });

    it("トークンを、引数にもURLにも入れず、実行時の環境変数だけで渡す", async () => {
      const { git, calls } = fakeGit();
      const url = "https://github.invalid/owner/name.git";
      await pushBranch(ctx(false), {
        git,
        mirrorDir: "/mirror",
        repo: REPO,
        url,
        token: TOKEN,
        branch: BRANCH,
      });
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call === undefined) throw new Error("unreachable");
      expect(call.args).toEqual([
        "push",
        "--quiet",
        "--force",
        "--no-verify",
        "--",
        url,
        `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
      ]);
      expect(call.options).toEqual({
        cwd: "/mirror",
        auth: { url, token: TOKEN },
      });
      // 実際に起動するときの形でも、引数にトークン(とその符号化)が現れない。
      const invocation = gitInvocation(call.args, call.options);
      const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
      expect(invocation.args.join(" ")).not.toContain(TOKEN);
      expect(invocation.args.join(" ")).not.toContain(encoded);
      expect(invocation.env.GIT_CONFIG_VALUE_0).toContain(encoded);
      expect(JSON.stringify(logs)).not.toContain(TOKEN);
      expect(JSON.stringify(logs)).not.toContain(encoded);
    });
  });
});

describe("本物のgitでのpush", () => {
  let tmp: string;
  let remote: string;
  let mirror: string;
  let marker: string;
  let head: string;
  const git = createGit();
  const { logger } = recordingLogger();

  /** 実行されたら `marker` に書き足す `pre-push` を、`hooksDir` に置く。 */
  const plantPrePush = (hooksDir: string) => {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, "pre-push"),
      `#!/bin/sh\necho pre-push >> '${marker}'\n`,
      { mode: 0o755 },
    );
  };

  const push = (branch = BRANCH) =>
    pushBranch(
      { dryRun: false, logger },
      { git, mirrorDir: mirror, repo: REPO, url: remote, token: TOKEN, branch },
    );

  const remoteHead = (branch = BRANCH) =>
    plainGit(remote, "rev-parse", `refs/heads/${branch}`);

  beforeEach(() => {
    tmp = makeTempDir();
    marker = path.join(tmp, "hook-fired");
    // push 先(GitHubの代わり)。
    remote = path.join(tmp, "remote.git");
    fs.mkdirSync(remote);
    plainGit(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    // ミラーの代わり。作業用のブランチにコミットを1つ持つ。
    mirror = makeRepo(path.join(tmp, "mirror"));
    plainGit(mirror, "checkout", "--quiet", "-b", BRANCH);
    head = commitFile(mirror, "change.txt", "change\n");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("ブランチを同じ名前で push する。やり直しても、履歴が変わっていても通る", async () => {
    expect(await push()).toBe(true);
    expect(remoteHead()).toBe(head);

    expect(await push()).toBe(true);
    expect(remoteHead()).toBe(head);

    // 差し戻しで、履歴が書き換わった場合。
    plainGit(mirror, "commit", "--quiet", "--amend", "-m", "rewritten");
    const rewritten = plainGit(mirror, "rev-parse", "HEAD");
    expect(rewritten).not.toBe(head);
    expect(await push()).toBe(true);
    expect(remoteHead()).toBe(rewritten);
    // ほかのブランチは push しない。
    expect(plainGit(remote, "for-each-ref", "--format=%(refname)")).toBe(
      `refs/heads/${BRANCH}`,
    );
  });

  describe("期待するリモートの先頭を渡したとき(lease)", () => {
    const pushWith = (expected: string | null) =>
      pushBranch(
        { dryRun: false, logger },
        {
          git,
          mirrorDir: mirror,
          repo: REPO,
          url: remote,
          branch: BRANCH,
          lease: { expected },
        },
      );
    /** 別のファクトリーが push した、という想定のコミットを、リモートのブランチに置く。 */
    const plantForeign = () => {
      const other = makeRepo(path.join(tmp, "other"));
      plainGit(other, "checkout", "--quiet", "-b", BRANCH);
      const foreign = commitFile(other, "foreign.txt", "foreign\n");
      plainGit(other, "push", "--quiet", "--force", remote, BRANCH);
      return foreign;
    };

    it("リモートにブランチがなければ、null を期待して push できる", async () => {
      expect(await pushWith(null)).toBe(true);
      expect(remoteHead()).toBe(head);
    });

    it("リモートの先頭が期待どおりなら、履歴が変わっていても上書きできる", async () => {
      await pushWith(null);
      plainGit(mirror, "commit", "--quiet", "--amend", "-m", "rewritten");
      const rewritten = plainGit(mirror, "rev-parse", "HEAD");
      expect(await pushWith(head)).toBe(true);
      expect(remoteHead()).toBe(rewritten);
    });

    it("ないはずのブランチがリモートにあれば、上書きせずに失敗する", async () => {
      const foreign = plantForeign();
      await expect(pushWith(null)).rejects.toThrow();
      expect(remoteHead()).toBe(foreign);
    });

    it("リモートの先頭が期待と違えば、上書きせずに失敗する", async () => {
      await pushWith(null);
      const foreign = plantForeign();
      await expect(pushWith(head)).rejects.toThrow();
      expect(remoteHead()).toBe(foreign);
    });

    it("期待する先頭がコミットのハッシュでなければ、gitを実行せずに失敗する", async () => {
      await expect(pushWith("main --force")).rejects.toThrow(/ハッシュ/);
      expect(plainGit(remote, "for-each-ref")).toBe("");
    });
  });

  it("リポジトリ内のフック(`hooks/pre-push`)が動かない", async () => {
    plantPrePush(path.join(mirror, ".git", "hooks"));

    // 守りを付けないgitでは動くことを、先に確かめる(テストが空振りしていないこと)。
    plainGit(mirror, "push", "--quiet", remote, `${BRANCH}:refs/heads/plain`);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    expect(await push()).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(remoteHead()).toBe(head);
  });

  it("リポジトリの設定でフックの場所を指定されても、動かない", async () => {
    const hooksDir = path.join(tmp, "planted-hooks");
    plantPrePush(hooksDir);
    plainGit(mirror, "config", "core.hooksPath", hooksDir);

    plainGit(mirror, "push", "--quiet", remote, `${BRANCH}:refs/heads/plain`);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    expect(await push()).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("トークンが、ミラーにも push 先にも残らない", async () => {
    await push();
    for (const dir of [mirror, remote]) {
      const files = fs
        .readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      expect(files.length).toBeGreaterThan(0);
      expect(
        files.filter((file) => fs.readFileSync(file).includes(TOKEN)),
      ).toEqual([]);
    }
    expect(plainGit(mirror, "remote")).toBe("");
  });
});
