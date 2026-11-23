import { describe, expect, it } from "vitest";
import { decideSettlement, type SettleInput } from "../src/office/settle.ts";

function decide(overrides: Partial<SettleInput>) {
  return decideSettlement({
    issueState: "in-progress",
    run: null,
    active: false,
    failedCount: 0,
    maxAttempts: 3,
    ...overrides,
  });
}

const running = (
  nextStep: NonNullable<SettleInput["run"]>["nextStep"],
  started = true,
) => ({ status: "running" as const, nextStep, started });
const finished = (
  status: "done" | "question" | "failed" | "held" | "cancelled",
) => ({
  status,
  nextStep: null,
  started: true,
});

describe("記録から決まる後処理", () => {
  it("実行がなければ、何もしない", () => {
    expect(decide({ run: null })).toBe("none");
  });

  describe("実行中の実行", () => {
    it("in-progress で、誰も進めていなければ、続きを進める", () => {
      expect(decide({ run: running("plan") })).toBe("advance");
      expect(decide({ run: running("prepare", false) })).toBe("advance");
    });

    it("すでに進めているなら、何もしない", () => {
      expect(decide({ run: running("plan"), active: true })).toBe("none");
    });

    it("ready のまま、まだ何も始めていなければ、着手の続きを行う", () => {
      expect(
        decide({ issueState: "ready", run: running("prepare", false) }),
      ).toBe("begin");
      expect(
        decide({
          issueState: "ready",
          run: running("prepare", false),
          active: true,
        }),
      ).toBe("none");
    });

    it("人間が状態を変えていたら、取り消す", () => {
      for (const issueState of [
        "triage",
        "needs-info",
        "blocked",
        "ready",
        "in-review",
        "failed",
        "closed",
      ]) {
        for (const active of [true, false]) {
          expect(
            decide({ issueState, run: running("implement"), active }),
            `${issueState} ${String(active)}`,
          ).toBe("cancel");
        }
      }
    });

    it("publish まで終わっていれば、in-review に進める", () => {
      expect(decide({ run: running("cleanup") })).toBe("to_review");
    });

    it("in-review の間は、クローズを待つ", () => {
      expect(decide({ issueState: "in-review", run: running("cleanup") })).toBe(
        "none",
      );
    });

    it("クローズされたら、cleanup を進める", () => {
      expect(decide({ issueState: "closed", run: running("cleanup") })).toBe(
        "advance",
      );
      expect(
        decide({ issueState: "closed", run: running("cleanup"), active: true }),
      ).toBe("none");
    });

    it("クローズを待つ間に人間が状態を変えたら、取り消す", () => {
      for (const issueState of ["triage", "ready", "needs-info", "failed"]) {
        expect(
          decide({ issueState, run: running("cleanup") }),
          issueState,
        ).toBe("cancel");
      }
    });
  });

  describe("終わった実行", () => {
    it("質問で終わっていれば、質問する", () => {
      expect(decide({ run: finished("question") })).toBe("ask");
    });

    it("人間の対応待ちで終わっていれば、理由を知らせて待つ。試行の数には左右されない", () => {
      expect(decide({ run: finished("held") })).toBe("hold");
      expect(decide({ run: finished("held"), failedCount: 3 })).toBe("hold");
    });

    it("失敗で、試行に余裕があれば、ready に戻す", () => {
      expect(decide({ run: finished("failed"), failedCount: 1 })).toBe("retry");
      expect(decide({ run: finished("failed"), failedCount: 2 })).toBe("retry");
    });

    it("失敗が試行の上限に達したら、failed にする", () => {
      expect(decide({ run: finished("failed"), failedCount: 3 })).toBe(
        "give_up",
      );
      expect(decide({ run: finished("failed"), failedCount: 4 })).toBe(
        "give_up",
      );
      expect(
        decide({ run: finished("failed"), failedCount: 1, maxAttempts: 1 }),
      ).toBe("give_up");
    });

    it("試行の上限が不正なら失敗する", () => {
      expect(() =>
        decide({ run: finished("failed"), failedCount: 1, maxAttempts: 0 }),
      ).toThrow(/試行の上限/);
    });

    it("取り消しと完了の後は、何もしない", () => {
      expect(decide({ run: finished("cancelled") })).toBe("none");
      expect(decide({ run: finished("done") })).toBe("none");
    });

    it("in-progress でなければ、何もしない(2回目以降は変わらない)", () => {
      for (const issueState of ["ready", "needs-info", "failed", "in-review"]) {
        for (const status of ["question", "failed", "held"] as const) {
          expect(
            decide({ issueState, run: finished(status), failedCount: 3 }),
            `${issueState} ${status}`,
          ).toBe("none");
        }
      }
    });
  });
});
