import { describe, expect, it } from "vitest";
import {
  type IntakeIssue,
  type IntakeRepo,
  intakeBlocker,
  orderForIntake,
  planIntake,
  utcDayStart,
} from "../src/office/intake.ts";

const REPO = "owner/name";
const OTHER = "owner/other";
const NOW = new Date("2026-03-01T12:00:00.000Z");

function issue(number: number, overrides: Partial<IntakeIssue> = {}) {
  return {
    repo: REPO,
    number,
    state: "ready",
    priority: null,
    author: "example-login",
    agentSkip: false,
    retryAt: null,
    ...overrides,
  } satisfies IntakeIssue;
}

function repo(overrides: Partial<IntakeRepo> = {}): IntakeRepo {
  return {
    repo: REPO,
    allowedAuthors: ["example-login"],
    maxParallel: 1,
    active: 0,
    ...overrides,
  };
}

const numbers = (issues: readonly IntakeIssue[]) =>
  issues.map((i) => `${i.repo}#${i.number}`);

describe("着手の順", () => {
  it("優先度の高い順に並べる。ラベルなしは最後", () => {
    const ordered = orderForIntake([
      issue(1),
      issue(2, { priority: "p3" }),
      issue(3, { priority: "p1" }),
      issue(4, { priority: "p0" }),
      issue(5, { priority: "p2" }),
    ]);
    expect(ordered.map((i) => i.number)).toEqual([4, 3, 5, 2, 1]);
  });

  it("優先度が同じなら、イシュー番号の若い順", () => {
    const ordered = orderForIntake([
      issue(30, { priority: "p1" }),
      issue(4, { priority: "p1" }),
      issue(12, { priority: "p1" }),
      issue(9),
      issue(2),
    ]);
    expect(ordered.map((i) => i.number)).toEqual([4, 12, 30, 2, 9]);
  });

  it("優先度は、番号より先に見る", () => {
    const ordered = orderForIntake([
      issue(1, { priority: "p2" }),
      issue(99, { priority: "p0" }),
    ]);
    expect(ordered.map((i) => i.number)).toEqual([99, 1]);
  });

  it("リポジトリをまたぐときは、優先度、設定に書いた順、番号の順に見る", () => {
    const ordered = orderForIntake(
      [
        issue(1),
        issue(2, { repo: OTHER }),
        issue(3, { repo: OTHER, priority: "p0" }),
        issue(4, { priority: "p1" }),
      ],
      [OTHER, REPO],
    );
    expect(numbers(ordered)).toEqual([
      `${OTHER}#3`,
      `${REPO}#4`,
      `${OTHER}#2`,
      `${REPO}#1`,
    ]);
  });

  it("入力の配列を書き換えない", () => {
    const input = [issue(2), issue(1)];
    orderForIntake(input);
    expect(input.map((i) => i.number)).toEqual([2, 1]);
  });
});

describe("着手の条件", () => {
  it("ready で、起票者が許可されていれば、着手できる", () => {
    expect(intakeBlocker(issue(1), repo(), NOW)).toBeNull();
  });

  it("ready 以外には着手しない", () => {
    for (const state of [
      "triage",
      "in-progress",
      "in-review",
      "failed",
      "closed",
    ]) {
      expect(intakeBlocker(issue(1, { state }), repo(), NOW), state).toBe(
        "not_ready",
      );
    }
  });

  it("agent:skip の付いたイシューには着手しない", () => {
    expect(intakeBlocker(issue(1, { agentSkip: true }), repo(), NOW)).toBe(
      "agent_skip",
    );
  });

  it("起票者が allowed_authors にいない、または分からないイシューには着手しない", () => {
    expect(intakeBlocker(issue(1, { author: "stranger" }), repo(), NOW)).toBe(
      "author_not_allowed",
    );
    expect(intakeBlocker(issue(1, { author: null }), repo(), NOW)).toBe(
      "author_not_allowed",
    );
    expect(intakeBlocker(issue(1), repo({ allowedAuthors: [] }), NOW)).toBe(
      "author_not_allowed",
    );
  });

  it("起票者のログイン名は、大文字と小文字を区別しない", () => {
    expect(
      intakeBlocker(issue(1, { author: "Example-Login" }), repo(), NOW),
    ).toBeNull();
  });

  it("待機時間が過ぎるまでは着手しない。ちょうどの時刻には着手できる", () => {
    const later = "2026-03-01T12:00:00.001Z";
    expect(intakeBlocker(issue(1, { retryAt: later }), repo(), NOW)).toBe(
      "waiting_retry",
    );
    expect(
      intakeBlocker(issue(1, { retryAt: NOW.toISOString() }), repo(), NOW),
    ).toBeNull();
  });

  it("条件を読めないリポジトリのイシューには着手しない", () => {
    expect(intakeBlocker(issue(1), undefined, NOW)).toBe("unknown_repo");
  });
});

describe("着手するイシューの決定", () => {
  const plan = (
    issues: IntakeIssue[],
    options: {
      repos?: IntakeRepo[];
      dailyLimit?: number;
      startedToday?: number;
    } = {},
  ) =>
    planIntake({
      issues,
      repos: options.repos ?? [repo()],
      dailyLimit: options.dailyLimit ?? 20,
      startedToday: options.startedToday ?? 0,
      now: NOW,
    });

  it("同時実行の枠までしか着手しない。拾うのは、着手の順で先のもの", () => {
    const result = plan([
      issue(3),
      issue(1, { priority: "p2" }),
      issue(2, { priority: "p0" }),
    ]);
    expect(result.starts.map((i) => i.number)).toEqual([2]);
    expect(result.skipped.map((s) => [s.issue.number, s.reason])).toEqual([
      [1, "no_slot"],
      [3, "no_slot"],
    ]);
  });

  it("進んでいる実行があれば、その分の枠を使っている", () => {
    expect(plan([issue(1)], { repos: [repo({ active: 1 })] }).starts).toEqual(
      [],
    );
    const two = plan([issue(1), issue(2), issue(3)], {
      repos: [repo({ maxParallel: 3, active: 1 })],
    });
    expect(two.starts.map((i) => i.number)).toEqual([1, 2]);
  });

  it("条件を満たさないイシューは、枠を使わない", () => {
    const result = plan([
      issue(1, { agentSkip: true, priority: "p0" }),
      issue(2),
    ]);
    expect(result.starts.map((i) => i.number)).toEqual([2]);
  });

  it("1日の上限に達していたら着手しない", () => {
    const result = plan([issue(1)], { dailyLimit: 20, startedToday: 20 });
    expect(result.starts).toEqual([]);
    expect(result.skipped).toEqual([
      { issue: issue(1), reason: "daily_limit" },
    ]);
  });

  it("1日の上限は、全リポジトリの合計で数える", () => {
    const result = plan(
      [issue(1), issue(1, { repo: OTHER }), issue(2, { repo: OTHER })],
      {
        repos: [
          repo({ maxParallel: 2 }),
          repo({ repo: OTHER, maxParallel: 2 }),
        ],
        dailyLimit: 5,
        startedToday: 3,
      },
    );
    expect(numbers(result.starts)).toEqual([`${REPO}#1`, `${OTHER}#1`]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["daily_limit"]);
  });

  it("同時実行の枠は、リポジトリごとに数える", () => {
    const result = plan([issue(1), issue(2), issue(1, { repo: OTHER })], {
      repos: [repo(), repo({ repo: OTHER })],
    });
    expect(numbers(result.starts)).toEqual([`${REPO}#1`, `${OTHER}#1`]);
  });
});

describe("UTCの1日の始まり", () => {
  it("UTCの0時を返す", () => {
    expect(utcDayStart(new Date("2026-03-01T23:59:59.999Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2026-03-02T00:00:00.000Z"))).toBe(
      "2026-03-02T00:00:00.000Z",
    );
  });
});
