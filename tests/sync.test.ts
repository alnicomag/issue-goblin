import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/office/clock.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import type { LogFields, Logger } from "../src/office/log.ts";
import { deriveIssue, syncAll } from "../src/office/sync.ts";
import { FakeGitHub, VALID_FACTORY_YML } from "./fake-github.ts";

const REPO = "owner/name";
const OTHER = "owner/other";

const T1 = "2026-03-01T00:00:01.000Z";
const T2 = "2026-03-01T00:00:02.000Z";
const T3 = "2026-03-01T00:00:03.000Z";
const NOW = "2026-03-01T01:00:00.000Z";

interface EventRow {
  type: string;
  repo: string | null;
  issue_number: number | null;
  payload: Record<string, unknown>;
  created_at: string;
  handled_at: string | null;
}

describe("同期", () => {
  let db: Db;
  let clock: Clock & { time: string };
  let logs: { level: string; event: string; fields: LogFields }[];
  let logger: Logger;
  let github: Map<string, FakeGitHub>;
  let fake: FakeGitHub;

  beforeEach(() => {
    db = openDb(":memory:");
    clock = { time: NOW, now: () => new Date(clock.time) };
    migrate(db, { clock });
    logs = [];
    const push =
      (level: string) =>
      (event: string, fields: LogFields = {}) =>
        void logs.push({ level, event, fields });
    logger = { info: push("info"), warn: push("warn"), error: push("error") };
    fake = new FakeGitHub();
    fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };
    github = new Map([[REPO, fake]]);
  });

  const sync = (
    options: { dryRun?: boolean; repos?: string[]; full?: string[] } = {},
  ) =>
    syncAll(
      {
        db,
        apiFor: (repo) => {
          const api = github.get(repo);
          if (!api) throw new Error(`no fake for ${repo}`);
          return api;
        },
        dryRun: options.dryRun ?? true,
        clock,
        logger,
      },
      options.repos ?? [REPO],
      { fullRepos: new Set(options.full ?? []) },
    );

  const events = (type?: string): EventRow[] => {
    const rows = db.prepare("SELECT * FROM events ORDER BY id").all() as (Omit<
      EventRow,
      "payload"
    > & { payload: string })[];
    return rows
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
      .filter((row) => type === undefined || row.type === type);
  };

  const issueRow = (number: number, repo = REPO) =>
    db
      .prepare("SELECT * FROM issues WHERE repo = ? AND number = ?")
      .get(repo, number) as Record<string, unknown> | undefined;

  const repoRow = (repo = REPO) =>
    db.prepare("SELECT * FROM repos WHERE repo = ?").get(repo) as Record<
      string,
      unknown
    >;

  it("新規イシューで、行とイベントができる", async () => {
    fake.putIssue({
      number: 1,
      title: "First",
      labels: ["state:ready", "priority:p1", "size:s", "unrelated"],
      author: "alice",
      updatedAt: T1,
    });

    const [result] = await sync();

    expect(result).toMatchObject({
      repo: REPO,
      ok: true,
      issues: 1,
      events: 1,
    });
    expect(issueRow(1)).toEqual({
      repo: REPO,
      number: 1,
      title: "First",
      state: "ready",
      priority: "p1",
      size: "s",
      depends_on: null,
      author: "alice",
      body: "",
      agent_skip: 0,
      approved: 0,
      github_updated_at: T1,
      synced_at: NOW,
    });
    expect(events()).toEqual([
      {
        id: 1,
        type: "issue.created",
        repo: REPO,
        issue_number: 1,
        payload: {
          title: "First",
          state: "ready",
          priority: "p1",
          size: "s",
          author: "alice",
        },
        created_at: NOW,
        handled_at: null,
      },
    ]);
  });

  it("ラベルが変わると、状態が更新され、変更前後を含むイベントができる", async () => {
    fake.putIssue({ number: 1, labels: ["state:triage"], updatedAt: T1 });
    await sync();

    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T2 });
    await sync();

    expect(issueRow(1)).toMatchObject({
      state: "ready",
      github_updated_at: T2,
    });
    expect(events("issue.state_changed")).toMatchObject([
      { issue_number: 1, payload: { from: "triage", to: "ready" } },
    ]);
  });

  it("遷移表にない変更も、人間の操作としてそのまま受け入れる", async () => {
    fake.putIssue({ number: 1, labels: ["state:failed"], updatedAt: T1 });
    await sync();
    fake.putIssue({ number: 1, labels: ["state:in-review"], updatedAt: T2 });
    await sync();

    expect(issueRow(1)).toMatchObject({ state: "in-review" });
    expect(events("issue.state_changed")).toMatchObject([
      { payload: { from: "failed", to: "in-review" } },
    ]);
  });

  it("クローズで、状態が closed になる", async () => {
    fake.putIssue({ number: 1, labels: ["state:in-review"], updatedAt: T1 });
    await sync();

    fake.putIssue({ number: 1, open: false, updatedAt: T2 });
    await sync();

    expect(issueRow(1)).toMatchObject({ state: "closed" });
    expect(events("issue.closed")).toMatchObject([
      { issue_number: 1, payload: { from: "in-review" } },
    ]);
    expect(events("issue.state_changed")).toEqual([]);
  });

  it("再オープンされると、ラベルの状態に戻る", async () => {
    fake.putIssue({
      number: 1,
      open: false,
      labels: ["state:in-review"],
      updatedAt: T1,
    });
    await sync();
    expect(issueRow(1)).toMatchObject({ state: "closed" });

    fake.putIssue({ number: 1, open: true, updatedAt: T2 });
    await sync();

    expect(issueRow(1)).toMatchObject({ state: "in-review" });
    expect(events("issue.state_changed")).toMatchObject([
      { payload: { from: "closed", to: "in-review" } },
    ]);
  });

  it("プルリクエストは取り込まれない", async () => {
    fake.putIssue({ number: 1, isPullRequest: true, updatedAt: T1 });
    fake.putIssue({ number: 2, labels: ["state:triage"], updatedAt: T2 });
    fake.putComment({
      id: 10,
      issueNumber: 1,
      onPullRequest: true,
      updatedAt: T2,
    });

    await sync();

    expect(issueRow(1)).toBeUndefined();
    expect(issueRow(2)).toBeDefined();
    expect(events().map((e) => e.issue_number)).toEqual([2]);
    expect(fake.writes).toEqual([]);
  });

  it("state: ラベルが複数あると、競合のイベントができ、状態は変わらない", async () => {
    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    await sync();

    fake.putIssue({
      number: 1,
      labels: ["state:ready", "state:blocked"],
      updatedAt: T2,
    });
    await sync();

    expect(issueRow(1)).toMatchObject({
      state: "ready",
      github_updated_at: T2,
    });
    expect(events("issue.label_conflict")).toMatchObject([
      {
        issue_number: 1,
        payload: { labels: ["state:ready", "state:blocked"], state: "ready" },
      },
    ]);
    expect(events("issue.state_changed")).toEqual([]);

    // 競合が続いていても、同じ内容ならイベントは増えない。
    await sync();
    expect(events("issue.label_conflict")).toHaveLength(1);
  });

  it("初めて見るイシューが競合していたら、triage として扱い、競合を記録する", async () => {
    fake.putIssue({
      number: 1,
      labels: ["state:ready", "state:blocked"],
      updatedAt: T1,
    });
    await sync({ dryRun: false });

    expect(issueRow(1)).toMatchObject({ state: "triage" });
    expect(events().map((e) => e.type)).toEqual([
      "issue.created",
      "issue.label_conflict",
    ]);
    expect(fake.writes).toEqual([]);
  });

  it("未知の state: ラベルは、エラーをログに出し、状態を変えない", async () => {
    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    await sync();
    fake.putIssue({ number: 1, labels: ["state:nonsense"], updatedAt: T2 });
    const [result] = await sync({ dryRun: false });

    expect(result?.ok).toBe(true);
    expect(issueRow(1)).toMatchObject({ state: "ready" });
    expect(events()).toHaveLength(1);
    expect(logs.filter((l) => l.event === "sync.unknown_state_label")).toEqual([
      {
        level: "error",
        event: "sync.unknown_state_label",
        fields: { repo: REPO, issue: 1, labels: ["state:nonsense"] },
      },
    ]);
    expect(fake.writes).toEqual([]);
  });

  it("コメントを記録する。<!-- factory --> を含むコメントは記録されない", async () => {
    fake.putIssue({ number: 1, labels: ["state:needs-info"], updatedAt: T1 });
    fake.putComment({
      id: 10,
      issueNumber: 1,
      body: "an answer from a human",
      author: "alice",
      updatedAt: T1,
    });
    fake.putComment({
      id: 11,
      issueNumber: 1,
      body: "a question\n<!-- factory -->",
      updatedAt: T2,
    });

    const [result] = await sync();

    expect(result).toMatchObject({ comments: 1 });
    expect(events("issue.commented")).toMatchObject([
      {
        repo: REPO,
        issue_number: 1,
        payload: {
          comment_id: 10,
          author: "alice",
          body: "an answer from a human",
          commented_at: T1,
        },
      },
    ]);
  });

  it("起票者、本文、agent:skip を保存し、変わったら更新する", async () => {
    fake.putIssue({
      number: 1,
      author: "example-login",
      body: "the body",
      labels: ["state:ready"],
      updatedAt: T1,
    });
    await sync();
    expect(issueRow(1)).toMatchObject({
      author: "example-login",
      body: "the body",
      agent_skip: 0,
    });

    fake.putIssue({
      number: 1,
      body: "edited",
      labels: ["state:ready", "agent:skip"],
      updatedAt: T2,
    });
    await sync();
    expect(issueRow(1)).toMatchObject({ body: "edited", agent_skip: 1 });
    // 状態は変わっていないので、イベントは増えない。
    expect(events().map((e) => e.type)).toEqual(["issue.created"]);
  });

  it("起票者が空のまま残っている行は、全件の取り直しで埋まる", async () => {
    fake.putIssue({ number: 1, author: "example-login", updatedAt: T1 });
    await sync();
    db.prepare("UPDATE issues SET author = NULL, body = NULL").run();

    await sync({ full: [REPO] });
    expect(issueRow(1)).toMatchObject({ author: "example-login", body: "" });
    expect(events("issue.created")).toHaveLength(1);
  });

  it("同じ内容を2回同期しても、イベントが増えない", async () => {
    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    fake.putIssue({ number: 2, open: false, updatedAt: T2 });
    fake.putIssue({ number: 3, labels: ["state:a", "state:b"], updatedAt: T3 });
    fake.putComment({ id: 10, issueNumber: 1, updatedAt: T3 });
    fake.file = null;

    await sync();
    const before = events();
    const issuesBefore = db.prepare("SELECT * FROM issues").all();
    expect(before.map((e) => e.type).sort()).toEqual([
      "issue.commented",
      "issue.created",
      "issue.created",
      "issue.created",
      "issue.label_conflict",
      "repo.config_missing",
    ]);

    clock.time = "2026-03-01T02:00:00.000Z";
    const [second] = await sync();
    await sync();

    expect(second).toMatchObject({
      ok: true,
      issues: 0,
      comments: 0,
      events: 0,
    });
    expect(events()).toEqual(before);
    expect(db.prepare("SELECT * FROM issues").all()).toEqual(issuesBefore);
  });

  it("取得位置を忘れて最初から取り直しても、イベントが増えない", async () => {
    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    fake.putComment({ id: 10, issueNumber: 1, updatedAt: T2 });
    await sync();
    const before = events();

    db.prepare(
      "UPDATE repos SET issues_synced_until = NULL, comments_synced_until = NULL",
    ).run();
    await sync();

    expect(events()).toEqual(before);
  });

  it("取得位置を進め、次回はそこから取得する", async () => {
    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    fake.putIssue({ number: 2, isPullRequest: true, updatedAt: T3 });
    fake.putComment({ id: 10, issueNumber: 1, updatedAt: T2 });

    await sync();
    expect(repoRow()).toMatchObject({
      issues_synced_until: T3,
      comments_synced_until: T2,
      last_polled_at: NOW,
    });

    fake.calls.length = 0;
    await sync();
    expect(fake.calls).toEqual([
      { method: "listIssues", repo: REPO, since: T3 },
      { method: "listIssueComments", repo: REPO, since: T2 },
      { method: "getFile", repo: REPO, path: "factory.yml", knownSha: "sha-1" },
    ]);
    // 何も取得できなくても、位置は戻らない。
    expect(repoRow()).toMatchObject({
      issues_synced_until: T3,
      comments_synced_until: T2,
    });
  });

  describe("新規イシューへのラベル付け", () => {
    it("dry_run が true のとき、書き込みの関数が1回も呼ばれない", async () => {
      fake.putIssue({ number: 1, labels: [], updatedAt: T1 });
      fake.putIssue({ number: 2, labels: ["priority:p0"], updatedAt: T2 });

      await sync({ dryRun: true });
      await sync({ dryRun: true });

      expect(fake.writes).toEqual([]);
      // DB上は triage として扱う。
      expect(issueRow(1)).toMatchObject({ state: "triage" });
      expect(issueRow(2)).toMatchObject({ state: "triage", priority: "p0" });
      // 付ける予定だったことは、イシューごとに1回だけログに出る。
      const skipped = logs.filter((l) => l.event === "github.write_skipped");
      expect(skipped.map((l) => l.fields)).toEqual([
        {
          reason: "dry_run",
          action: "add_labels",
          repo: REPO,
          issue: 1,
          labels: ["state:triage"],
        },
        {
          reason: "dry_run",
          action: "add_labels",
          repo: REPO,
          issue: 2,
          labels: ["state:triage"],
        },
      ]);
    });

    it("dry_run が false のとき、state:triage を1回だけ付ける", async () => {
      fake.putIssue({ number: 1, labels: [], updatedAt: T1 });
      fake.putIssue({ number: 2, labels: ["state:ready"], updatedAt: T1 });
      fake.putIssue({ number: 3, open: false, labels: [], updatedAt: T1 });

      await sync({ dryRun: false });
      await sync({ dryRun: false });
      await sync({ dryRun: false });

      expect(fake.writes).toEqual([
        {
          method: "addLabels",
          repo: REPO,
          issueNumber: 1,
          labels: ["state:triage"],
        },
      ]);
      expect(issueRow(1)).toMatchObject({ state: "triage" });
      expect(events().map((e) => e.type)).toEqual([
        "issue.created",
        "issue.created",
        "issue.created",
      ]);
    });

    it("dry_run の間に取り込んだイシューにも、全件の取り直しでラベルを付ける", async () => {
      fake.putIssue({ number: 1, labels: [], updatedAt: T1 });
      fake.putIssue({ number: 2, labels: [], updatedAt: T2 });
      fake.putIssue({ number: 3, labels: ["state:ready"], updatedAt: T3 });
      await sync({ dryRun: true });
      const before = events();

      // 起動直後の1回目は、全件を取り直す。
      fake.calls.length = 0;
      await sync({ dryRun: false, full: [REPO] });
      await sync({ dryRun: false });

      expect(fake.calls[0]).toEqual({
        method: "listIssues",
        repo: REPO,
        since: null,
      });
      expect(
        fake.writes.map(
          (call) => call.method === "addLabels" && call.issueNumber,
        ),
      ).toEqual([1, 2]);
      expect(events()).toEqual(before);
    });

    it("全件の取り直しでも、dry_run が true なら書き込まない", async () => {
      fake.putIssue({ number: 1, labels: [], updatedAt: T1 });
      await sync({ dryRun: true });
      await sync({ dryRun: true, full: [REPO] });
      expect(fake.writes).toEqual([]);
    });

    it("ラベル付けに失敗したら、次回のポーリングでやり直す", async () => {
      fake.putIssue({ number: 1, labels: [], updatedAt: T1 });
      fake.failWritesWith = new Error("write failed");

      const [first] = await sync({ dryRun: false });
      expect(first?.ok).toBe(false);
      expect(issueRow(1)).toBeUndefined();
      expect(events()).toEqual([]);

      fake.failWritesWith = null;
      const [second] = await sync({ dryRun: false });
      expect(second?.ok).toBe(true);
      expect(issueRow(1)).toMatchObject({ state: "triage" });
      expect(events().map((e) => e.type)).toEqual(["issue.created"]);
      expect(fake.writes).toHaveLength(2);
    });
  });

  it("1つのリポジトリでエラーが起きても、他のリポジトリは同期される", async () => {
    const broken = new FakeGitHub();
    broken.failWith = new Error("boom");
    const other = new FakeGitHub();
    other.file = { sha: "sha-o", content: VALID_FACTORY_YML };
    other.putIssue({ number: 7, labels: ["state:ready"], updatedAt: T1 });
    github = new Map([
      ["owner/broken", broken],
      [OTHER, other],
    ]);

    const results = await sync({ repos: ["owner/broken", OTHER] });

    expect(results.map((r) => [r.repo, r.ok])).toEqual([
      ["owner/broken", false],
      [OTHER, true],
    ]);
    expect(issueRow(7, OTHER)).toMatchObject({ state: "ready" });
    expect(logs.filter((l) => l.level === "error")).toMatchObject([
      {
        event: "sync.repo_failed",
        fields: { repo: "owner/broken", error: "boom" },
      },
    ]);
    // 失敗したリポジトリは、取得位置も最終同期時刻も進まない。
    expect(repoRow("owner/broken")).toMatchObject({
      issues_synced_until: null,
      last_polled_at: null,
    });

    // 次回のポーリングで再試行される。
    broken.failWith = null;
    broken.file = { sha: "sha-b", content: VALID_FACTORY_YML };
    broken.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    const retry = await sync({ repos: ["owner/broken", OTHER] });
    expect(retry.every((r) => r.ok)).toBe(true);
    expect(issueRow(1, "owner/broken")).toBeDefined();
  });

  it("同じ番号のイシューを、リポジトリごとに別々に持つ", async () => {
    const other = new FakeGitHub();
    other.file = { sha: "sha-o", content: VALID_FACTORY_YML };
    github.set(OTHER, other);
    fake.putIssue({ number: 1, labels: ["state:ready"], updatedAt: T1 });
    other.putIssue({ number: 1, labels: ["state:blocked"], updatedAt: T1 });

    await sync({ repos: [REPO, OTHER] });

    expect(issueRow(1, REPO)).toMatchObject({ state: "ready" });
    expect(issueRow(1, OTHER)).toMatchObject({ state: "blocked" });
  });
});

describe("状態の導出", () => {
  it.each([
    [{ open: true, labels: ["state:ready"] }, "ready"],
    [{ open: true, labels: ["state:in-progress", "bug"] }, "in-progress"],
    [{ open: false, labels: ["state:ready"] }, "closed"],
    [{ open: false, labels: ["state:a", "state:b"] }, "closed"],
    [{ open: true, labels: [] }, "triage"],
  ])("%j → %s", (issue, state) => {
    const derived = deriveIssue(issue);
    expect(derived.state).toBe(state);
    expect(derived.problem).toBeNull();
  });

  it("state: ラベルがないオープンのイシューだけ、ラベル付けの対象になる", () => {
    expect(deriveIssue({ open: true, labels: ["bug"] }).needsTriageLabel).toBe(
      true,
    );
    expect(deriveIssue({ open: false, labels: [] }).needsTriageLabel).toBe(
      false,
    );
    expect(
      deriveIssue({ open: true, labels: ["state:ready"] }).needsTriageLabel,
    ).toBe(false);
  });

  it("state:closed はラベルとしては不正", () => {
    expect(deriveIssue({ open: true, labels: ["state:closed"] })).toMatchObject(
      {
        state: null,
        problem: { kind: "unknown" },
      },
    );
  });

  it("優先度と規模を読む。複数ある、または不明な値なら空にして警告する", () => {
    expect(
      deriveIssue({ open: true, labels: ["priority:p3", "size:l"] }),
    ).toMatchObject({ priority: "p3", size: "l", warnings: [] });
    const bad = deriveIssue({
      open: true,
      labels: ["priority:p0", "priority:p1", "size:xl"],
    });
    expect(bad.priority).toBeNull();
    expect(bad.size).toBeNull();
    expect(bad.warnings).toHaveLength(2);
  });
});
