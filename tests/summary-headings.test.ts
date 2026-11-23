import { describe, expect, it } from "vitest";
import {
  checkJudgementTable,
  checkSummaryHeadings,
  SUMMARY_HEADINGS,
  summaryHeadings,
} from "../scripts/summary-headings.ts";
import { DEFAULT_PROMPTS_DIR, loadPrompt } from "../src/agents/prompts.ts";

const IMPLEMENT = [
  "### 変更の内容",
  "",
  "空の名前の扱いを足した。",
  "",
  "### 実行したコマンドと結果",
  "",
  "- テスト: 通った",
  "",
  "### 計画との違い",
  "",
  "なし",
  "",
  "### 未検証",
  "",
  "なし",
].join("\n");

const REVIEW = [
  "### 受け入れ条件ごとの判定",
  "",
  "| 条件 | 判定 | 根拠 |",
  "| --- | --- | --- |",
  "| 空の名前を扱う | 合格 | テストがある |",
  "",
  "### 範囲とパス",
  "",
  "なし",
  "",
  "### 提案",
  "",
  "なし",
].join("\n");

describe("checkSummaryHeadings", () => {
  it("決めた見出しが、その順で並んでいれば合格する", () => {
    expect(checkSummaryHeadings(IMPLEMENT, SUMMARY_HEADINGS.implement)).toEqual(
      { ok: true },
    );
    expect(checkSummaryHeadings(REVIEW, SUMMARY_HEADINGS.review)).toEqual({
      ok: true,
    });
  });

  it("見出しが欠けていれば、期待と実際を挙げて不合格にする", () => {
    const result = checkSummaryHeadings(
      IMPLEMENT.replace("### 未検証", "未検証"),
      SUMMARY_HEADINGS.implement,
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "見出しが決めたとおりではありません。期待: 変更の内容、実行したコマンドと結果、計画との違い、未検証。実際: 変更の内容、実行したコマンドと結果、計画との違い",
    });
  });

  it("順が違えば不合格にする", () => {
    const swapped = REVIEW.replace("### 範囲とパス", "### 仮")
      .replace("### 提案", "### 範囲とパス")
      .replace("### 仮", "### 提案");
    expect(checkSummaryHeadings(swapped, SUMMARY_HEADINGS.review).ok).toBe(
      false,
    );
  });

  it("余分な見出しがあれば不合格にする", () => {
    expect(
      checkSummaryHeadings(`${REVIEW}\n\n### その他\n`, SUMMARY_HEADINGS.review)
        .ok,
    ).toBe(false);
  });

  it("見出しがなければ、実際を「なし」として不合格にする", () => {
    const result = checkSummaryHeadings("実装した。", SUMMARY_HEADINGS.review);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("実際: なし");
  });

  it("コードブロックの中の行と、レベルの違う見出しは、見出しに数えない", () => {
    expect(
      summaryHeadings(
        ["## 上", "### 一", "```", "### 中", "```", "#### 下", "### 二 "].join(
          "\n",
        ),
      ),
    ).toEqual(["一", "二"]);
  });
});

describe("checkJudgementTable", () => {
  it("条件、判定、根拠の表に行があれば合格する", () => {
    expect(checkJudgementTable(REVIEW)).toEqual({ ok: true });
  });

  it("表がなければ不合格にする", () => {
    expect(
      checkJudgementTable(
        REVIEW.split("\n")
          .filter((line) => !line.startsWith("|"))
          .join("\n"),
      ),
    ).toEqual({ ok: false, reason: "条件、判定、根拠の表がありません" });
  });

  it("列が違えば不合格にする", () => {
    expect(
      checkJudgementTable(
        REVIEW.replace("| 条件 | 判定 | 根拠 |", "| 条件 | 結果 |"),
      ).ok,
    ).toBe(false);
  });

  it("受け入れ条件の行がなければ不合格にする", () => {
    expect(
      checkJudgementTable(
        REVIEW.replace("| 空の名前を扱う | 合格 | テストがある |\n", ""),
      ),
    ).toEqual({ ok: false, reason: "表に、受け入れ条件の行がありません" });
  });

  it("ほかの見出しの下にある表は、判定の表として数えない", () => {
    const moved = [
      "### 受け入れ条件ごとの判定",
      "",
      "なし",
      "",
      "### 範囲とパス",
      "",
      "| 条件 | 判定 | 根拠 |",
      "| --- | --- | --- |",
      "| a | b | c |",
      "",
      "### 提案",
    ].join("\n");
    expect(checkJudgementTable(moved).ok).toBe(false);
  });
});

describe("指示書との一致", () => {
  it.each(["implement", "review"] as const)(
    "%s の指示書の見本が、確認に使う見出しと一致する",
    (name) => {
      const text = loadPrompt(DEFAULT_PROMPTS_DIR, name);
      const sample = /```markdown\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "";
      expect(checkSummaryHeadings(sample, SUMMARY_HEADINGS[name])).toEqual({
        ok: true,
      });
    },
  );
});
