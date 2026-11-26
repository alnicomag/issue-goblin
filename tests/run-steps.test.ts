import { describe, expect, it } from "vitest";
import {
  MAX_REWORKS,
  type NextAction,
  nextAction,
  nextRetryAt,
  retryWaitMinutes,
  STEP_NAMES,
  type StepName,
  type StepOutcome,
} from "../src/office/run-steps.ts";

const run = (step: StepName): NextAction => ({ kind: "run_step", step });
const next = (
  step: StepName,
  outcome: StepOutcome,
  reworkCount = 0,
): NextAction => nextAction({ reworkCount }, { step, outcome });

describe("ステップの進み方", () => {
  it("最初は prepare から始める", () => {
    expect(nextAction({ reworkCount: 0 }, null)).toEqual(run("prepare"));
  });

  it("通常は prepare から cleanup まで順に進み、cleanup の後に完了する", () => {
    // docs/design.md の「ワーカーの実行手順」の並びを、実装とは別に書き写したもの。
    const order: StepName[] = [
      "prepare",
      "plan",
      "implement",
      "verify",
      "review",
      "publish",
      "cleanup",
    ];
    expect(STEP_NAMES).toEqual(order);

    const visited: StepName[] = [];
    let action = nextAction({ reworkCount: 0 }, null);
    while (action.kind === "run_step") {
      visited.push(action.step);
      action = next(action.step, "done");
    }
    expect(visited).toEqual(order);
    expect(action).toEqual({ kind: "finish", status: "done" });
  });

  it("verify の失敗と review の修正要求は implement に戻す", () => {
    expect(next("verify", "rework")).toEqual(run("implement"));
    expect(next("review", "rework")).toEqual(run("implement"));
  });

  it("publish が人間の対応待ちを返すと、実行を held で終える", () => {
    expect(next("publish", "held")).toEqual({ kind: "finish", status: "held" });
    // 差し戻しの回数には左右されない。
    expect(next("publish", "held", 2)).toEqual({
      kind: "finish",
      status: "held",
    });
  });

  it("prepare が人間の対応待ちを返すと(リモートに残ったブランチ)、実行を held で終える", () => {
    expect(next("prepare", "held")).toEqual({ kind: "finish", status: "held" });
  });

  it("prepare と publish のほかは、人間の対応待ちを返せない", () => {
    for (const step of STEP_NAMES.filter(
      (name) => name !== "prepare" && name !== "publish",
    )) {
      expect(() => next(step, "held"), step).toThrow(/人間の対応待ち/);
    }
  });

  it("差し戻しは1回の実行で2回までで、3回目は失敗で終える", () => {
    expect(MAX_REWORKS).toBe(2);
    for (const step of ["verify", "review"] as const) {
      expect(next(step, "rework", 0), step).toEqual(run("implement"));
      expect(next(step, "rework", 1), step).toEqual(run("implement"));
      expect(next(step, "rework", 2), step).toEqual({
        kind: "finish",
        status: "failed",
      });
    }
  });

  it("差し戻しの後も、通常の進行は変わらない", () => {
    expect(next("implement", "done", 2)).toEqual(run("verify"));
    expect(next("verify", "done", 2)).toEqual(run("review"));
    expect(next("review", "done", 2)).toEqual(run("publish"));
  });

  it("質問を返したら、質問で終了する", () => {
    for (const step of ["plan", "implement", "review"] as const) {
      expect(next(step, "question"), step).toEqual({
        kind: "finish",
        status: "question",
      });
    }
  });

  it("どのステップでも、失敗したら失敗で終了する", () => {
    for (const step of STEP_NAMES) {
      expect(next(step, "failed"), step).toEqual({
        kind: "finish",
        status: "failed",
      });
    }
  });

  it("あり得ない組み合わせはエラーにする", () => {
    for (const step of [
      "prepare",
      "plan",
      "implement",
      "publish",
      "cleanup",
    ] as const) {
      expect(() => next(step, "rework"), step).toThrow("差し戻しを返せません");
    }
    for (const step of ["prepare", "verify", "publish", "cleanup"] as const) {
      expect(() => next(step, "question"), step).toThrow("質問を返せません");
    }
    expect(() => nextAction({ reworkCount: -1 }, null)).toThrow(
      "差し戻しの回数が不正です",
    );
  });
});

describe("待機時間", () => {
  const waits = [5, 30, 120];

  it("失敗の回数に応じて決まり、回数が足りなければ最後の値を使う", () => {
    expect(retryWaitMinutes(1, waits)).toBe(5);
    expect(retryWaitMinutes(2, waits)).toBe(30);
    expect(retryWaitMinutes(3, waits)).toBe(120);
    expect(retryWaitMinutes(4, waits)).toBe(120);
    expect(retryWaitMinutes(10, [7])).toBe(7);
  });

  it("不正な入力はエラーにする", () => {
    expect(() => retryWaitMinutes(0, waits)).toThrow("失敗の回数が不正です");
    expect(() => retryWaitMinutes(1, [])).toThrow("待機時間が1つも");
  });

  it("次に再試行してよい時刻は、UTCのISO 8601形式になる", () => {
    const finishedAt = new Date("2026-01-02T23:50:00.000Z");
    expect(nextRetryAt(finishedAt, 1, waits)).toBe("2026-01-02T23:55:00.000Z");
    expect(nextRetryAt(finishedAt, 2, waits)).toBe("2026-01-03T00:20:00.000Z");
    expect(nextRetryAt(finishedAt, 5, waits)).toBe("2026-01-03T01:50:00.000Z");
  });
});
