import { describe, expect, it } from "vitest";
import { classifyRemoteBranch } from "../src/office/branch-guard.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("リモートに残った作業用のブランチの見分け方", () => {
  it("リモートにブランチがなければ、absent", () => {
    expect(
      classifyRemoteBranch({
        remoteTip: null,
        publishedHeads: new Set([A]),
        mirrorHead: B,
      }),
    ).toEqual({ kind: "absent" });
  });

  it("先頭が、push した記録のあるコミットなら、own", () => {
    expect(
      classifyRemoteBranch({
        remoteTip: A,
        publishedHeads: new Set([B, A]),
        mirrorHead: C,
      }),
    ).toEqual({ kind: "own", tip: A });
  });

  it("先頭が、ミラーに取り込んだ先頭と同じなら、own(push の後、記録の前に止まった場合)", () => {
    expect(
      classifyRemoteBranch({
        remoteTip: A,
        publishedHeads: new Set(),
        mirrorHead: A,
      }),
    ).toEqual({ kind: "own", tip: A });
  });

  it("どちらにも一致しなければ、foreign", () => {
    expect(
      classifyRemoteBranch({
        remoteTip: A,
        publishedHeads: new Set([B]),
        mirrorHead: C,
      }),
    ).toEqual({ kind: "foreign", tip: A });
    expect(
      classifyRemoteBranch({
        remoteTip: A,
        publishedHeads: new Set(),
        mirrorHead: null,
      }),
    ).toEqual({ kind: "foreign", tip: A });
  });
});
