import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPTS_DIR,
  loadPrompt,
  promptPlaceholders,
  renderPrompt,
} from "../src/agents/prompts.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadPrompt", () => {
  it("指示書のファイルを読む", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "plan.md"), "# 計画\n\n手順を書く。\n");
    expect(loadPrompt(dir, "plan")).toBe("# 計画\n\n手順を書く。\n");
  });

  it("ファイルがなければ、場所の分かるメッセージで失敗する", () => {
    const dir = tempDir();
    expect(() => loadPrompt(dir, "missing")).toThrow(
      `指示書を読めません: ${path.join(dir, "missing.md")}`,
    );
  });

  it("中身が空なら失敗する", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "empty.md"), " \n");
    expect(() => loadPrompt(dir, "empty")).toThrow("指示書が空です");
  });

  it("置き場所の外を指す名前を通さない", () => {
    const dir = tempDir();
    for (const name of ["../secret", "a/b", "", "Plan", "plan.md", "-x"]) {
      expect(() => loadPrompt(dir, name), name).toThrow(
        "指示書の名前が不正です",
      );
    }
  });

  it("既定の置き場所は、リポジトリの prompts/ である", () => {
    expect(DEFAULT_PROMPTS_DIR).toBe(path.resolve("prompts"));
  });
});

describe("renderPrompt", () => {
  const template =
    "# 計画\n\n{{issue}}\n\n設定:\n{{factory_yml}}\n\n再掲: {{issue}}\n";

  it("指示書にある名前を、重複なしで挙げる", () => {
    expect(promptPlaceholders(template)).toEqual(["issue", "factory_yml"]);
    expect(promptPlaceholders("差し込む場所なし")).toEqual([]);
  });

  it("名前に対応する値を、すべての場所に差し込む", () => {
    expect(
      renderPrompt(template, { issue: "本文", factory_yml: "version: 1" }),
    ).toBe("# 計画\n\n本文\n\n設定:\nversion: 1\n\n再掲: 本文\n");
  });

  it("値が欠けていれば、欠けている名前を挙げて失敗する", () => {
    expect(() => renderPrompt(template, { issue: "本文" })).toThrow(
      "指示書に差し込む値が欠けています: factory_yml",
    );
    expect(() => renderPrompt(template, {})).toThrow(
      "指示書に差し込む値が欠けています: issue, factory_yml",
    );
  });

  it("空文字は、渡したものとして扱う", () => {
    expect(renderPrompt("指摘:\n{{feedback}}\n", { feedback: "" })).toBe(
      "指摘:\n\n",
    );
  });

  it("指示書にない名前の値は、失敗する", () => {
    expect(() =>
      renderPrompt(template, { issue: "a", factory_yml: "b", isue: "c" }),
    ).toThrow("指示書にない名前の値が渡されました: isue");
  });

  it("値の中の差し込む場所や置換の記号を、展開しない", () => {
    expect(
      renderPrompt("A: {{a}}\nB: {{b}}\n", {
        a: "{{b}} $& $1 {{c}}",
        b: "秘密",
      }),
    ).toBe("A: {{b}} $& $1 {{c}}\nB: 秘密\n");
  });

  it("オブジェクトが元から持つ名前を、値として扱わない", () => {
    expect(() => renderPrompt("{{constructor}}", {})).toThrow(
      "指示書に差し込む値が欠けています: constructor",
    );
  });
});
