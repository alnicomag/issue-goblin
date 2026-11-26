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

    describe("PRへの修正依頼", () => {
      const waiting = running("cleanup");
      const pending = { pending: true, slot: true };

      it("in-review で、未使用の依頼と枠があれば、やり直す", () => {
        expect(
          decide({
            issueState: "in-review",
            run: waiting,
            changeRequest: pending,
          }),
        ).toBe("rework");
      });

      it("in-review で、枠がなければ、待つ", () => {
        expect(
          decide({
            issueState: "in-review",
            run: waiting,
            changeRequest: { pending: true, slot: false },
          }),
        ).toBe("none");
      });

      it("依頼がなければ、いままでどおり", () => {
        const none = { pending: false, slot: true };
        expect(
          decide({
            issueState: "in-review",
            run: waiting,
            changeRequest: none,
          }),
        ).toBe("none");
        expect(
          decide({
            issueState: "in-progress",
            run: waiting,
            changeRequest: none,
          }),
        ).toBe("to_review");
      });

      it("in-progress で依頼が残っていれば、in-review に戻さずに、やり直す(状態を進めた後で止まった場合)", () => {
        expect(
          decide({
            issueState: "in-progress",
            run: waiting,
            changeRequest: { pending: true, slot: false },
          }),
        ).toBe("rework");
      });

      it("クローズ済みなら、依頼があっても、cleanup を進める", () => {
        expect(
          decide({
            issueState: "closed",
            run: waiting,
            changeRequest: pending,
          }),
        ).toBe("advance");
      });

      it("人間が状態を変えていれば、依頼があっても、取り消す", () => {
        for (const issueState of ["triage", "ready", "needs-info", "failed"]) {
          expect(
            decide({ issueState, run: waiting, changeRequest: pending }),
            issueState,
          ).toBe("cancel");
        }
      });

      it("クローズ待ちでない実行では、依頼を見ない", () => {
        expect(
          decide({
            issueState: "in-progress",
            run: running("review"),
            changeRequest: pending,
          }),
        ).toBe("advance");
      });
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

    describe("人間の承認", () => {
      const held = (
        reason: "needs_approval" | "forbidden" | null,
        approval: "none" | "pending" | "used" = "none",
      ) => ({ ...finished("held"), held: { reason, approval } });
      const waiting = { issueState: "needs-info" };

      it("needs_approval で待っている実行は、ラベルが付いたら承認として進める", () => {
        expect(
          decide({
            ...waiting,
            run: held("needs_approval"),
            approvedLabel: true,
          }),
        ).toBe("approve");
      });

      it("ラベルがなければ、待ち続ける", () => {
        expect(decide({ ...waiting, run: held("needs_approval") })).toBe(
          "none",
        );
        expect(
          decide({
            ...waiting,
            run: held("needs_approval"),
            approvedLabel: false,
          }),
        ).toBe("none");
      });

      it("承認を記録した後で止まっていたら、ラベルがなくても続きを行う", () => {
        expect(
          decide({ ...waiting, run: held("needs_approval", "pending") }),
        ).toBe("approve");
        expect(decide({ run: held("needs_approval", "pending") })).toBe(
          "resume",
        );
      });

      it("使用済みの承認では、もう一度進めない(同じ変更を、ラベルだけで通さない)", () => {
        expect(
          decide({
            ...waiting,
            run: held("needs_approval", "used"),
            approvedLabel: true,
          }),
        ).toBe("none");
        // 再開した publish がまた止まった直後は、理由を知らせて待つ。
        expect(decide({ run: held("needs_approval", "used") })).toBe("hold");
      });

      it("forbidden で止まった実行と、理由を読めない実行は、ラベルがあっても進めない", () => {
        for (const reason of ["forbidden", null] as const) {
          for (const approval of ["none", "pending", "used"] as const) {
            expect(
              decide({
                ...waiting,
                run: held(reason, approval),
                approvedLabel: true,
              }),
              `${String(reason)} ${approval}`,
            ).toBe("none");
          }
        }
      });

      it("質問や失敗で終わった実行は、ラベルがあっても進めない", () => {
        for (const status of ["question", "failed", "done"] as const) {
          expect(
            decide({ ...waiting, run: finished(status), approvedLabel: true }),
            status,
          ).toBe("none");
        }
      });

      it("needs-info と in-progress のほかの状態では、ラベルがあっても進めない", () => {
        for (const issueState of ["triage", "ready", "in-review", "failed"]) {
          expect(
            decide({
              issueState,
              run: held("needs_approval", "pending"),
              approvedLabel: true,
            }),
            issueState,
          ).toBe("none");
        }
      });

      it("実行中の実行は、ラベルに左右されない", () => {
        expect(decide({ run: running("implement"), approvedLabel: true })).toBe(
          "advance",
        );
      });
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

describe("担当から外れたイシュー", () => {
  const unassigned = (overrides: Partial<SettleInput>) =>
    decide({ assigned: false, ...overrides });

  it("実行中の実行は、進めているかによらず、どの状態でも取り消す", () => {
    for (const issueState of ["ready", "in-progress", "needs-info"]) {
      for (const active of [false, true]) {
        expect(unassigned({ issueState, run: running("plan"), active })).toBe(
          "cancel",
        );
      }
    }
    expect(
      unassigned({ issueState: "ready", run: running("prepare", false) }),
    ).toBe("cancel");
  });

  it("クローズ待ちの実行も、取り消す。修正依頼があっても、やり直さない", () => {
    for (const issueState of ["in-progress", "in-review"]) {
      expect(
        unassigned({
          issueState,
          run: running("cleanup"),
          changeRequest: { pending: true, slot: true },
        }),
      ).toBe("cancel");
    }
  });

  it("クローズ済みのイシューの cleanup は、いままでどおり行う", () => {
    expect(unassigned({ issueState: "closed", run: running("cleanup") })).toBe(
      "advance",
    );
    expect(
      unassigned({
        issueState: "closed",
        run: running("cleanup"),
        active: true,
      }),
    ).toBe("none");
    expect(unassigned({ issueState: "closed", run: running("plan") })).toBe(
      "cancel",
    );
  });

  it("終わった実行の後処理(質問、失敗、人間の対応待ち、承認)は、行わない", () => {
    for (const status of ["question", "failed", "held", "done"] as const) {
      expect(unassigned({ run: finished(status), failedCount: 3 })).toBe(
        "none",
      );
    }
    expect(
      unassigned({
        issueState: "needs-info",
        run: {
          ...finished("held"),
          held: { reason: "needs_approval", approval: "none" },
        },
        approvedLabel: true,
      }),
    ).toBe("none");
  });

  it("担当のまま(assigned が true、または省略)なら、いままでと同じ", () => {
    expect(decide({ assigned: true, run: running("plan") })).toBe("advance");
    expect(decide({ run: finished("question") })).toBe("ask");
  });
});
