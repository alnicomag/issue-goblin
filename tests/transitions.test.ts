import { describe, expect, it } from "vitest";
import {
  ACTORS,
  type Actor,
  ISSUE_STATES,
  type IssueState,
  isTransitionAllowed,
  TRANSITION_SOURCES,
  type TransitionSource,
} from "../src/office/transitions.ts";

// docs/stage0.md 5.3 の表を、実装とは別に書き写したもの。
const TABLE: ReadonlyArray<readonly [TransitionSource, IssueState, Actor]> = [
  ["new", "triage", "office"],
  ["triage", "ready", "conductor"],
  ["triage", "needs-info", "conductor"],
  ["triage", "blocked", "conductor"],
  ["needs-info", "triage", "office"],
  // 人間が、保護対象のパスに触れる変更を承認した(docs/design.md の遷移表で足した行)。
  ["needs-info", "in-progress", "office"],
  ["blocked", "triage", "office"],
  ["ready", "in-progress", "office"],
  ["in-progress", "in-review", "office"],
  ["in-progress", "needs-info", "office"],
  ["in-progress", "ready", "office"],
  ["in-progress", "failed", "office"],
  ["in-review", "in-progress", "office"],
  ["in-review", "closed", "human"],
  ["failed", "triage", "office"],
];

const inTable = (from: TransitionSource, to: IssueState, actor: Actor) =>
  TABLE.some(([f, t, a]) => f === from && t === to && a === actor);

describe("遷移表", () => {
  it.each(TABLE)("%s → %s (%s) は許可される", (from, to, actor) => {
    expect(isTransitionAllowed(from, to, actor)).toBe(true);
  });

  it("表にない組み合わせはすべて拒否される", () => {
    let rejected = 0;
    for (const from of TRANSITION_SOURCES) {
      for (const to of ISSUE_STATES) {
        for (const actor of ACTORS) {
          if (inTable(from, to, actor)) continue;
          expect(
            isTransitionAllowed(from, to, actor),
            `${from} → ${to} (${actor})`,
          ).toBe(false);
          rejected += 1;
        }
      }
    }
    expect(rejected).toBe(
      TRANSITION_SOURCES.length * ISSUE_STATES.length * ACTORS.length -
        TABLE.length,
    );
  });

  it.each(TABLE)(
    "%s → %s は実行者が %s でなければ拒否される",
    (from, to, actor) => {
      for (const other of ACTORS) {
        if (other === actor) continue;
        expect(isTransitionAllowed(from, to, other)).toBe(false);
      }
    },
  );

  it("同じ状態への遷移は拒否される", () => {
    for (const state of ISSUE_STATES) {
      for (const actor of ACTORS) {
        expect(isTransitionAllowed(state, state, actor)).toBe(false);
      }
    }
  });
});
