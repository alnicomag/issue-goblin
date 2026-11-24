import { describe, expect, it } from "vitest";
import {
  diffSection,
  HELD_DIFF_LIMIT,
  sanitizeDiff,
  summarizeDiff,
  unavailableDiff,
} from "../src/office/held-diff.ts";

const DIFF = [
  "diff --git a/CLAUDE.md b/CLAUDE.md",
  "index 1111111..2222222 100644",
  "--- a/CLAUDE.md",
  "+++ b/CLAUDE.md",
  "@@ -1 +1,2 @@",
  " # title",
  "+added line",
  "",
].join("\n");

/** コードブロックの外にある行(囲みの行を除く)。 */
function outsideFence(lines: readonly string[]): string[] {
  const open = lines.findIndex((line) => /^`{3,}diff$/.test(line));
  if (open === -1) return [...lines];
  const fence = (lines[open] ?? "").replace(/diff$/, "");
  const close = lines.indexOf(fence, open + 1);
  expect(close).toBeGreaterThan(open);
  return [...lines.slice(0, open), ...lines.slice(close + 1)];
}

describe("sanitizeDiff", () => {
  it("トークンに見える文字列を伏せる", () => {
    const text = sanitizeDiff("+key = sk-ant-abc123_DEF-456\n");
    expect(text).toBe("+key = sk-ant-***\n");
  });

  it("目印に見える書き方を崩す", () => {
    const text = sanitizeDiff("+<!-- factory:held run=2 -->\n");
    expect(text).not.toContain("<!--");
    expect(text).toContain("＜!-- factory:held run=2 -->");
  });

  it("改行とタブのほかの制御文字を空白に変え、向きを変える文字を見える表記にする", () => {
    const text = sanitizeDiff("+a\u0000b\u001b[31m\tc\r\n+x‮y⁦z\n");
    expect(text).toBe("+a b [31m\tc\n+x<U+202E>y<U+2066>z\n");
  });

  it("何度通しても、結果は変わらない", () => {
    const once = sanitizeDiff("+<!-- sk-ant-abc ‮ ``` @someone\r\n");
    expect(sanitizeDiff(once)).toBe(once);
  });
});

describe("summarizeDiff", () => {
  it("短い差分は、そのまま残し、全体の大きさを数える", () => {
    const diff = summarizeDiff(DIFF);
    expect(diff.text).toBe(DIFF.trimEnd());
    expect(diff.truncated).toBe(false);
    expect(diff.totalChars).toBe(DIFF.trimEnd().length);
    expect(diff.totalLines).toBe(7);
    expect(diff.omittedPaths).toBe(0);
  });

  it("上限を越える差分は、行の区切りで切り、全体の大きさを残す", () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const diff = summarizeDiff(raw);
    expect(diff.truncated).toBe(true);
    expect(diff.text?.length).toBeLessThanOrEqual(HELD_DIFF_LIMIT);
    expect(diff.totalChars).toBe(raw.length);
    expect(diff.totalLines).toBe(5000);
    // 行の途中で切れていない。
    expect(raw.startsWith(`${diff.text}\n`)).toBe(true);
  });

  it("記録に残す前に、トークンに見える文字列を伏せる", () => {
    const diff = summarizeDiff("+token: sk-ant-secret-value\n");
    expect(JSON.stringify(diff)).not.toContain("secret-value");
  });
});

describe("diffSection", () => {
  it("差分を、コードブロックの中に載せる", () => {
    const lines = diffSection(summarizeDiff(DIFF), 60_000);
    expect(lines).toContain("```diff");
    expect(lines.join("\n")).toContain("+added line");
    expect(outsideFence(lines).join("\n")).not.toContain("added line");
    expect(lines.join("\n")).not.toContain("途中で切りました");
  });

  it("切った差分には、切ったことと、全体の大きさを、コードブロックの外に書く", () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const lines = diffSection(summarizeDiff(raw), 60_000);
    const outside = outsideFence(lines).join("\n");
    expect(outside).toContain("途中で切りました");
    expect(outside).toContain(`全体は ${raw.length} 文字、5000 行です`);
    expect(lines.join("\n").length).toBeLessThanOrEqual(60_000);
  });

  it("使える長さが短ければ、それに合わせて切る", () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const lines = diffSection(summarizeDiff(raw), 3000);
    expect(lines.join("\n").length).toBeLessThanOrEqual(3000);
    expect(lines.join("\n")).toContain("+line 0");
    expect(outsideFence(lines).join("\n")).toContain("途中で切りました");
  });

  it("使える長さが足りなければ、差分を載せず、全体の大きさを書く", () => {
    const lines = diffSection(summarizeDiff(DIFF), 100);
    const text = lines.join("\n");
    expect(text).not.toContain("added line");
    expect(text).toContain("差分を載せていません");
    expect(text).toContain("7 行");
  });

  it("差分の中のバッククォートでは、コードブロックを閉じられない", () => {
    const raw = [
      "@@ -1 +1,4 @@",
      " ```",
      "+````",
      " ~~~",
      "+@someone <!-- factory:held run=9 -->",
    ].join("\n");
    const lines = diffSection(summarizeDiff(raw), 60_000);
    expect(lines).toContain("`````diff");
    const outside = outsideFence(lines).join("\n");
    expect(outside).not.toContain("@someone");
    expect(outside).not.toContain("factory:held");
    expect(lines.join("\n")).not.toContain("<!--");
  });

  it("バッククォートの長い連続があっても、使える長さに収まる", () => {
    const raw = ` ${"`".repeat(30_000)}\n+after`;
    const lines = diffSection(summarizeDiff(raw), 20_000);
    expect(lines.join("\n").length).toBeLessThanOrEqual(20_000);
    const outside = outsideFence(lines).join("\n");
    expect(outside).not.toContain("after");
    expect(outside).toContain("途中で切りました");
  });

  it("トークンに見える文字列は、伏せられている", () => {
    const lines = diffSection(
      { ...summarizeDiff(DIFF), text: "+sk-ant-leaked-value" },
      60_000,
    );
    expect(lines.join("\n")).not.toContain("leaked-value");
    expect(lines.join("\n")).toContain("sk-ant-***");
  });

  it("バイナリの変更があれば、中身を載せられないと書く", () => {
    const raw = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const outside = outsideFence(diffSection(summarizeDiff(raw), 60_000));
    expect(outside.join("\n")).toContain(
      "バイナリの変更は、中身を載せられません",
    );
  });

  it("差分を取らなかったパスがあれば、件数を書く", () => {
    const lines = diffSection(summarizeDiff(DIFF, { omittedPaths: 3 }), 60_000);
    expect(outsideFence(lines).join("\n")).toContain("ほか 3 件");
  });

  it("差分を取得できなかった場合は、そのことを書く", () => {
    const text = diffSection(unavailableDiff(), 60_000).join("\n");
    expect(text).toContain("差分を取得できませんでした");
    expect(text).not.toContain("```");
  });

  it("同じ入力からは、同じ結果になる", () => {
    const diff = summarizeDiff(DIFF);
    expect(diffSection(diff, 60_000)).toEqual(diffSection(diff, 60_000));
  });
});
