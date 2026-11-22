import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS_DIR, loadPrompt } from "../src/agents/prompts.ts";

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
