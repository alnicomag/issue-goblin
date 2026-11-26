import { describe, expect, it } from "vitest";
import { reviewCommentsFrom } from "../src/office/github.ts";

/**
 * GitHubの「PRのレビューコメントの一覧」(`GET /repos/{owner}/{repo}/pulls/{number}/comments`)が
 * 返す形。行番号(`line`、`original_line`)と、属するレビュー(`pull_request_review_id`)が入る。
 * レビューごとの一覧(`.../reviews/{id}/comments`)は、行番号を返さない。
 */
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  pull_request_review_id: 11,
  path: "src/example.ts",
  position: 1,
  original_position: 5,
  line: 20,
  original_line: 20,
  subject_type: "line",
  body: "行の指摘",
  ...overrides,
});

describe("レビューの行ごとのコメントの読み取り", () => {
  it("そのレビューのコメントだけを、行番号とあわせて返す", () => {
    expect(
      reviewCommentsFrom(
        [
          raw(),
          raw({ id: 2, pull_request_review_id: 12, body: "別のレビュー" }),
          raw({ id: 3, line: 7, original_line: 7, body: "もう1件" }),
        ],
        11,
        "owner/name のPR 2",
      ),
    ).toEqual([
      { id: 1, path: "src/example.ts", line: 20, body: "行の指摘" },
      { id: 3, path: "src/example.ts", line: 7, body: "もう1件" },
    ]);
  });

  it("コメントの後でコミットが積まれて位置が古くなっても、コメントを書いた時点の行を返す", () => {
    expect(
      reviewCommentsFrom(
        [raw({ line: null, position: null })],
        11,
        "owner/name のPR 2",
      ),
    ).toEqual([{ id: 1, path: "src/example.ts", line: 20, body: "行の指摘" }]);
  });

  it("ファイル全体へのコメントは、行が null になる", () => {
    expect(
      reviewCommentsFrom(
        [raw({ line: null, original_line: null, subject_type: "file" })],
        11,
        "owner/name のPR 2",
      ),
    ).toEqual([
      { id: 1, path: "src/example.ts", line: null, body: "行の指摘" },
    ]);
  });

  it("想定外の形の応答は、原因の分かるメッセージで失敗する", () => {
    expect(() =>
      reviewCommentsFrom([{ id: "x" }], 11, "owner/name のPR 2"),
    ).toThrow(/owner\/name のPR 2/);
  });
});
