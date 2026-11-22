/**
 * 指示書の読み込み。
 *
 * Claudeに渡す指示は、コードに埋め込まずに `prompts/` のファイルに置く。
 * 変更の履歴を、コードとは別に追えるようにするためである。
 */
import fs from "node:fs";
import path from "node:path";

/** 指示書の置き場所(このリポジトリの `prompts/`)。 */
export const DEFAULT_PROMPTS_DIR = path.resolve(
  import.meta.dirname,
  "../../prompts",
);

/** 指示書の名前として使える書き方。ファイル名は `<名前>.md` になる。 */
const PROMPT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 指示書を読む。名前が不正な場合、ファイルがない場合、中身が空の場合は、
 * 場所の分かるメッセージで失敗する。
 */
export function loadPrompt(promptsDir: string, name: string): string {
  if (!PROMPT_NAME.test(name)) {
    throw new Error(
      `指示書の名前が不正です: ${name}(英小文字、数字、ハイフンだけを使えます)`,
    );
  }
  const file = path.join(promptsDir, `${name}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`指示書を読めません: ${file}`, { cause: error });
  }
  if (text.trim() === "") {
    throw new Error(`指示書が空です: ${file}`);
  }
  return text;
}
