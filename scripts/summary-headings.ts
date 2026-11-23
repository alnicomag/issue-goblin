/**
 * `done` のときの要約(`summary`)が、指示書で決めた見出しを持つかを調べる。
 *
 * 指示書の確認(scripts/prompts-check.ts)とテストだけが使う。
 * 事務局は要約の中身を解釈しないので、`src/` からは使わない。
 */

/** `done` のときに、要約に書かせる見出し。指示書(`prompts/`)に書いた順である。 */
export const SUMMARY_HEADINGS = {
  implement: ["変更の内容", "実行したコマンドと結果", "計画との違い", "未検証"],
  review: ["受け入れ条件ごとの判定", "範囲とパス", "提案"],
} as const;

export type SummaryCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** 要約の中の見出し(`### 名前`)を、出てくる順に挙げる。コードブロックの中は数えない。 */
export function summaryHeadings(summary: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of summary.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^### (.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** 要約が、決めた見出しを、その順で、過不足なく持つかを調べる。 */
export function checkSummaryHeadings(
  summary: string,
  expected: readonly string[],
): SummaryCheck {
  const found = summaryHeadings(summary);
  if (
    found.length === expected.length &&
    found.every((heading, index) => heading === expected[index])
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `見出しが決めたとおりではありません。期待: ${expected.join("、")}。実際: ${found.length === 0 ? "なし" : found.join("、")}`,
  };
}

/** 見出しから次の見出しまでの本文。見出しがなければ、空文字。 */
export function summarySection(summary: string, heading: string): string {
  const lines = summary.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `### ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("### "));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

/** 「受け入れ条件ごとの判定」が、条件、判定、根拠の表で、1行以上の中身を持つかを調べる。 */
export function checkJudgementTable(summary: string): SummaryCheck {
  const rows = summarySection(summary, "受け入れ条件ごとの判定")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  const [header, separator, ...body] = rows;
  if (
    header === undefined ||
    header.length !== 3 ||
    header[0] !== "条件" ||
    header[1] !== "判定" ||
    header[2] !== "根拠"
  ) {
    return { ok: false, reason: "条件、判定、根拠の表がありません" };
  }
  if (separator === undefined || !separator.every((c) => /^:?-+:?$/.test(c))) {
    return { ok: false, reason: "表の区切りの行がありません" };
  }
  if (body.length === 0) {
    return { ok: false, reason: "表に、受け入れ条件の行がありません" };
  }
  return { ok: true };
}
