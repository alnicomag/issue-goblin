import { describe, expect, it } from "vitest";
import {
  isAssignedTo,
  isAssignedToOthers,
  parseAssignees,
} from "../src/office/assignees.ts";

describe("担当者の記録の読み取り", () => {
  it("JSON配列を読む。未取得(null)は null のまま返す", () => {
    expect(parseAssignees('["alice","bob"]')).toEqual(["alice", "bob"]);
    expect(parseAssignees("[]")).toEqual([]);
    expect(parseAssignees(null)).toBeNull();
  });

  it.each(["alice", '{"login":"alice"}', "[1]"])(
    "配列として読めない値(%s)は、失敗させる",
    (text) => {
      expect(() => parseAssignees(text)).toThrow(/担当者の記録/);
    },
  );
});

describe("担当の照合", () => {
  it("持ち主が null(担当者で分けない)なら、いつも扱う", () => {
    expect(isAssignedTo(null, null)).toBe(true);
    expect(isAssignedTo(["someone-else"], null)).toBe(true);
    expect(isAssignedToOthers(["someone-else"], null)).toBe(false);
  });

  it("担当者に持ち主がいれば扱う。大文字と小文字は区別しない", () => {
    expect(isAssignedTo(["Example-Bot"], "example-bot")).toBe(true);
    expect(isAssignedTo(["someone-else"], "example-bot")).toBe(false);
    expect(isAssignedTo([], "example-bot")).toBe(false);
    expect(isAssignedTo(null, "example-bot")).toBe(false);
  });

  it("ほかの人だけが担当しているのは、担当者がいて、持ち主がいないとき", () => {
    expect(isAssignedToOthers(["someone-else"], "example-bot")).toBe(true);
    expect(isAssignedToOthers([], "example-bot")).toBe(false);
    expect(
      isAssignedToOthers(["someone-else", "EXAMPLE-BOT"], "example-bot"),
    ).toBe(false);
  });
});
