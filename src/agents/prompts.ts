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

/** 指示書の中の、値を差し込む場所。`{{名前}}` と書く。 */
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;

/** 指示書に書かれている、差し込む場所の名前(重複なし、出てくる順)。 */
export function promptPlaceholders(template: string): string[] {
  return [
    ...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1])),
  ].filter((name) => name !== undefined);
}

/**
 * 指示書に値を差し込む純粋関数。
 *
 * - 指示書にある名前の値が渡されていなければ、失敗する(空文字は、渡したものとして扱う)。
 * - 指示書にない名前の値が渡されていても、失敗する(名前の打ち間違いに気づくため)。
 * - 置き換えは1回だけ行う。値の中に `{{名前}}` があっても、展開しない
 *   (値はイシューの本文など、外から来た文章だからである)。
 */
export function renderPrompt(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const names = promptPlaceholders(template);
  const missing = names.filter((name) => !Object.hasOwn(values, name));
  if (missing.length > 0) {
    throw new Error(`指示書に差し込む値が欠けています: ${missing.join(", ")}`);
  }
  const unknown = Object.keys(values).filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `指示書にない名前の値が渡されました: ${unknown.join(", ")}`,
    );
  }
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`指示書に差し込む値が欠けています: ${name}`);
    }
    return value;
  });
}
