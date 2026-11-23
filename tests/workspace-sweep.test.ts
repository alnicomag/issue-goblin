import { describe, expect, it } from "vitest";
import { decideSweep, type SweepInput } from "../src/office/workspace-sweep.ts";

const T1 = "2026-03-01T01:00:00.000Z";
const T2 = "2026-03-01T02:00:00.000Z";
const T3 = "2026-03-01T03:00:00.000Z";

function decide(overrides: Partial<SweepInput>) {
  return decideSweep({
    issueState: "ready",
    runs: [],
    active: false,
    returnedFromFailedAt: null,
    ...overrides,
  });
}

const finished = (
  status: "done" | "question" | "failed" | "held" | "cancelled",
  finishedAt: string,
) => ({ status, finishedAt });
const running = { status: "running" as const, finishedAt: null };

describe("作業場所を消すか残すかの判定", () => {
  describe("クローズされたイシュー", () => {
    it.each(["question", "failed", "held", "cancelled", "done"] as const)(
      "最新の実行が %s で終わっていても、消す",
      (status) => {
        expect(
          decide({ issueState: "closed", runs: [finished(status, T1)] }),
        ).toBe("remove_closed");
      },
    );

    it("実行の記録がなくても、消す", () => {
      expect(decide({ issueState: "closed" })).toBe("remove_closed");
    });

    it("実行中の実行があれば、残す", () => {
      expect(
        decide({
          issueState: "closed",
          runs: [finished("failed", T1), running],
        }),
      ).toBe("keep");
    });

    it("取り消した実行を、このプロセスがまだ止め終えていなければ、残す", () => {
      expect(
        decide({
          issueState: "closed",
          runs: [finished("cancelled", T1)],
          active: true,
        }),
      ).toBe("keep");
    });
  });

  describe("failed から戻されたイシュー", () => {
    it("すべての実行が、戻した時刻までに終わっていれば、消す", () => {
      expect(
        decide({
          issueState: "ready",
          runs: [finished("failed", T1), finished("failed", T2)],
          returnedFromFailedAt: T2,
        }),
      ).toBe("remove_returned");
    });

    it("戻した先の状態によらない", () => {
      for (const issueState of ["triage", "ready", "blocked", "needs-info"]) {
        expect(
          decide({
            issueState,
            runs: [finished("failed", T1)],
            returnedFromFailedAt: T2,
          }),
        ).toBe("remove_returned");
      }
    });

    it("戻した後に始まった実行が実行中なら、残す", () => {
      expect(
        decide({
          issueState: "in-progress",
          runs: [finished("failed", T1), running],
          returnedFromFailedAt: T2,
        }),
      ).toBe("keep");
    });

    it("戻した後に終わった実行があれば、残す", () => {
      for (const status of [
        "failed",
        "question",
        "held",
        "cancelled",
      ] as const) {
        expect(
          decide({
            issueState: "ready",
            runs: [finished("failed", T1), finished(status, T3)],
            returnedFromFailedAt: T2,
          }),
        ).toBe("keep");
      }
    });

    it("実行を、このプロセスがまだ止め終えていなければ、残す", () => {
      expect(
        decide({
          issueState: "ready",
          runs: [finished("failed", T1)],
          returnedFromFailedAt: T2,
          active: true,
        }),
      ).toBe("keep");
    });
  });

  describe("残す場合", () => {
    it("失敗の後の再試行を待っている", () => {
      expect(
        decide({ issueState: "ready", runs: [finished("failed", T1)] }),
      ).toBe("keep");
    });

    it("試行の上限に達して failed になった(戻されるまで)", () => {
      expect(
        decide({ issueState: "failed", runs: [finished("failed", T1)] }),
      ).toBe("keep");
    });

    it("質問で終わった", () => {
      expect(
        decide({ issueState: "needs-info", runs: [finished("question", T1)] }),
      ).toBe("keep");
    });

    it("人間の対応待ちで止まった", () => {
      expect(
        decide({ issueState: "needs-info", runs: [finished("held", T1)] }),
      ).toBe("keep");
    });

    it("人間のラベル変更で取り消された", () => {
      for (const issueState of ["triage", "ready", "blocked", "needs-info"]) {
        expect(decide({ issueState, runs: [finished("cancelled", T1)] })).toBe(
          "keep",
        );
      }
    });

    it("実行中", () => {
      expect(decide({ issueState: "in-progress", runs: [running] })).toBe(
        "keep",
      );
    });

    it("DBにないイシュー", () => {
      expect(decide({ issueState: null })).toBe("keep");
      expect(decide({ issueState: null, returnedFromFailedAt: T1 })).toBe(
        "keep",
      );
    });
  });

  it("同じ入力からは、同じ答えが出る", () => {
    const input: SweepInput = {
      issueState: "closed",
      runs: [finished("question", T1)],
      active: false,
      returnedFromFailedAt: null,
    };
    expect(decideSweep(input)).toBe(decideSweep(input));
  });
});
