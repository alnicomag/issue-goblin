/**
 * コメントとPRの本文に載せる、当たったパスの一覧。
 *
 * パスはワーカーが決められる文字列で、長さにも決まりがない。件数と、1件の長さの両方に上限を
 * 設けて、一覧の全体が決まった大きさに収まるようにする。どれも純粋関数である。
 */
import type { PathHit } from "./paths.ts";

/** 一覧に挙げるパスの数の上限。残りは件数だけを書く。 */
export const LISTED_PATH_LIMIT = 50;

/** 一覧に書くパス1件の、文字数の上限。越えた分は、中ほどを省く。 */
export const PATH_CHAR_LIMIT = 200;

/** 一覧に書くパターン1件の、文字数の上限。越えた分は、中ほどを省く。 */
export const PATTERN_CHAR_LIMIT = 100;

/** 省いた位置に置く印。 */
const ELLIPSIS = "…";

/**
 * パスやパターンを、コメントやPRの本文のコードの中に書ける形にする。
 *
 * パスはワーカーが決められる文字列なので、コードの外に抜け出す書き方(バッククォート、改行)と、
 * 目印に見える書き方(HTMLコメントの始まり)を崩す。コードの中なので、メンションは通知にならない。
 */
export function inlineCode(text: string): string {
  const safe = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を空白に置き換える
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("`", "'")
    .replaceAll("<!--", "＜!--");
  return `\`${safe}\``;
}

/**
 * 上限より長い文字列の、中ほどを省く。先頭と末尾を残す(パスは、末尾にファイル名がある)。
 * 文字の途中(サロゲートペア)では切らない。結果は、上限以下の長さになる。
 */
function elideMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = limit - ELLIPSIS.length;
  const headLength = Math.ceil(keep * 0.6);
  let head = text.slice(0, headLength);
  let tail = text.slice(text.length - (keep - headLength));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head}${ELLIPSIS}${tail}`;
}

/**
 * 当たったパスとパターンの一覧を、箇条書きの行にする。
 *
 * - 先頭の `LISTED_PATH_LIMIT` 件までを挙げ、残りは件数だけを書く。
 * - 長いパスとパターンは、中ほどを省き、省いたことと元の長さを、行の後ろに書く。
 * - 省いてから、コードとして書ける形にする(`inlineCode`)。省いた後の文字列にも、同じ守りが掛かる。
 *
 * 1行は、決まった長さを越えない。そのため、一覧の全体も、決まった大きさに収まる。
 */
export function pathHitLines(hits: readonly PathHit[]): string[] {
  const lines = hits.slice(0, LISTED_PATH_LIMIT).map((hit) => {
    const path = elideMiddle(hit.path, PATH_CHAR_LIMIT);
    const pattern = elideMiddle(hit.pattern, PATTERN_CHAR_LIMIT);
    const notes = [
      ...(path === hit.path ? [] : [`パスは ${hit.path.length} 文字`]),
      ...(pattern === hit.pattern
        ? []
        : [`パターンは ${hit.pattern.length} 文字`]),
    ];
    const note =
      notes.length === 0
        ? ""
        : `(${notes.join("、")}で、長いので中ほどを省きました)`;
    return `- ${inlineCode(path)}(パターン: ${inlineCode(pattern)})${note}`;
  });
  const rest = hits.length - LISTED_PATH_LIMIT;
  if (rest > 0) lines.push(`- (ほか ${rest} 件)`);
  return lines;
}
