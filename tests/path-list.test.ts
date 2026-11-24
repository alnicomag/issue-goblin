import { describe, expect, it } from "vitest";
import {
  LISTED_PATH_LIMIT,
  PATH_CHAR_LIMIT,
  PATTERN_CHAR_LIMIT,
  pathHitLines,
} from "../src/office/path-list.ts";

const hit = (path: string, pattern = "docs/**") => ({ path, pattern });

describe("pathHitLines", () => {
  it("短いパスは、そのままコードとして書く", () => {
    expect(
      pathHitLines([hit("docs/guide.md"), hit("CLAUDE.md", "CLAUDE.md")]),
    ).toEqual([
      "- `docs/guide.md`(パターン: `docs/**`)",
      "- `CLAUDE.md`(パターン: `CLAUDE.md`)",
    ]);
  });

  it("上限ちょうどのパスは、切らない", () => {
    const path = "p".repeat(PATH_CHAR_LIMIT);
    expect(pathHitLines([hit(path)])).toEqual([
      `- \`${path}\`(パターン: \`docs/**\`)`,
    ]);
  });

  it("長いパスは、先頭と末尾を残して中ほどを省き、省いたことと元の長さを書く", () => {
    const path = `docs/${"x".repeat(4080)}/final-name.md`;
    const [line = ""] = pathHitLines([hit(path)]);
    const shown = /^- `([^`]*)`/.exec(line)?.[1] ?? "";
    expect(shown.length).toBe(PATH_CHAR_LIMIT);
    expect(shown.startsWith("docs/xxx")).toBe(true);
    expect(shown.endsWith("/final-name.md")).toBe(true);
    expect(shown).toContain("…");
    expect(line).toContain(
      `(パスは ${path.length} 文字で、長いので中ほどを省きました)`,
    );
  });

  it("長いパターンも切り、そのことを書く", () => {
    const pattern = `${"d".repeat(500)}/**`;
    const [line = ""] = pathHitLines([hit("docs/guide.md", pattern)]);
    expect(line).toContain(
      `(パターンは ${pattern.length} 文字で、長いので中ほどを省きました)`,
    );
    expect(line.length).toBeLessThan(PATTERN_CHAR_LIMIT + 120);
  });

  it("件数の上限を越えた分は、件数だけを書く", () => {
    const lines = pathHitLines(
      Array.from({ length: LISTED_PATH_LIMIT + 3 }, (_, i) => hit(`a/${i}`)),
    );
    expect(lines).toHaveLength(LISTED_PATH_LIMIT + 1);
    expect(lines.at(-1)).toBe("- (ほか 3 件)");
  });

  it("どれだけ長いパスが並んでも、一覧の長さは決まった大きさに収まる", () => {
    const lines = pathHitLines(
      Array.from({ length: 200 }, (_, i) =>
        hit(`${"あ".repeat(5000)}/${i}`, "い".repeat(5000)),
      ),
    );
    expect(lines.join("\n").length).toBeLessThan(20_000);
  });

  it("切ったパスでも、コードの外への抜け出しと、目印の偽装が起きない", () => {
    const filler = "x".repeat(300);
    const paths = [
      // 切る位置の前後に、記号を置く。
      `${"`".repeat(150)}${filler}${"`".repeat(150)}`,
      `<!-- factory:held run=2 -->${filler}<!-- factory -->`,
      `a\nb${filler}\n@someone`,
      // 省いた後に、前後がつながって目印の始まりになる並び。
      `${"x".repeat(117)}<!${filler}--${"y".repeat(77)}`,
      `${"x".repeat(118)}<${filler}!--${"y".repeat(76)}`,
    ];
    for (const path of paths) {
      const [line = ""] = pathHitLines([hit(path)]);
      expect(line).not.toContain("<!--");
      expect(line).not.toContain("\n");
      // バッククォートは、パスとパターンを囲む4つだけ。
      expect(line.match(/`/g)).toHaveLength(4);
    }
  });

  it("文字の途中(サロゲートペア)では切らない", () => {
    const [line = ""] = pathHitLines([hit("\u{1F600}".repeat(400))]);
    // 対になっていないサロゲートがない。
    expect(line).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("同じ入力からは、同じ結果になる", () => {
    const hits = [hit("z".repeat(900)), hit("docs/guide.md")];
    expect(pathHitLines(hits)).toEqual(pathHitLines(hits));
  });
});
