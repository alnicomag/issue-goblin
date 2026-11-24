/**
 * 人間の承認待ちのコメントに載せる、保護対象のパスの差分。
 *
 * 差分はワーカーが決められる文章である。ここでは、中身を解釈せず、コメントのほかの部分や
 * GitHubの動きに作用する書き方だけを、機械的に崩す。どれも純粋関数で、DBにもgitにも触れない。
 */
import { z } from "zod";
import { maskSecrets } from "./step-log.ts";

/** 記録とコメントに載せる差分の、文字数の上限。越えた分は、切ったことを明記して切る。 */
export const HELD_DIFF_LIMIT = 40_000;

/** これより短くしか載せられないときは、差分を載せずに、載せられないと書く。 */
export const HELD_DIFF_MIN_BUDGET = 500;

/** publish が承認待ちで止まったときに、チェックポイントに残す差分。 */
export const ProtectedDiffSchema = z.object({
  /**
   * 無害化して、上限までに切った差分。取得できなかった場合は null。
   * 止まったコミットと、既定ブランチと分かれた位置との差分で、保護対象のパスだけを含む。
   */
  text: z.string().nullable(),
  /** 無害化した差分の全体の文字数。 */
  totalChars: z.number().int().nonnegative(),
  /** 差分の全体の行数。 */
  totalLines: z.number().int().nonnegative(),
  /** 上限で切ったか。 */
  truncated: z.boolean(),
  /** 差分を取らなかった保護対象のパスの数(パスが多い場合)。 */
  omittedPaths: z.number().int().nonnegative(),
});
export type ProtectedDiff = z.infer<typeof ProtectedDiffSchema>;

/** 差分を取得できなかったときの記録。 */
export function unavailableDiff(omittedPaths = 0): ProtectedDiff {
  return {
    text: null,
    totalChars: 0,
    totalLines: 0,
    truncated: false,
    omittedPaths,
  };
}

/**
 * 差分を、記録とコメントに載せられる形にする。何度通しても、結果は変わらない。
 *
 * - トークンに見える文字列を伏せる(ログと同じ伏せ方)。
 * - HTMLコメントの始まり(`<!--`)を、全角の `<` に変える。目印は本文の文字列の一致で探すので、
 *   コードブロックの中でも崩す。
 * - 改行とタブのほかの制御文字を、空白に変える。
 * - 文字の並びの向きを変える制御文字を、見える表記(`<U+202E>` など)に変える。
 *   見た目と中身を食い違わせないためである。
 */
export function sanitizeDiff(diff: string): string {
  return (
    maskSecrets(diff)
      .replace(/\r\n/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を空白に置き換える
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
      .replace(
        /[‪-‮⁦-⁩]/g,
        (char) =>
          `<U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
      )
      .replaceAll("<!--", "＜!--")
  );
}

/** 上限までに切る。できるだけ行の区切りで切り、文字の途中では切らない。 */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let head = text.slice(0, Math.max(0, limit));
  // 文字の途中(サロゲートペアの前半)で切らない。
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const lineEnd = head.lastIndexOf("\n");
  return lineEnd > 0 ? head.slice(0, lineEnd) : head;
}

/**
 * gitの差分を、チェックポイントに残す形にする。無害化してから、上限までに切る。
 * 全体の大きさは、切る前のものを残す。
 */
export function summarizeDiff(
  raw: string,
  options: { limit?: number; omittedPaths?: number } = {},
): ProtectedDiff {
  const full = sanitizeDiff(raw).replace(/\n+$/, "");
  const text = cut(full, options.limit ?? HELD_DIFF_LIMIT);
  return {
    text,
    totalChars: full.length,
    totalLines: full === "" ? 0 : full.split("\n").length,
    truncated: text.length < full.length,
    omittedPaths: options.omittedPaths ?? 0,
  };
}

/** 文章の中の、バッククォートの最長の連続の長さ。 */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

/** 囲みのバッククォートの、最短の数。 */
const MIN_FENCE = 3;

/** コードブロックの囲み。中のどの連続よりも長くして、中から閉じられないようにする。 */
function fenceFor(text: string): string {
  return "`".repeat(Math.max(MIN_FENCE, longestBacktickRun(text) + 1));
}

/** コードブロックのうち、差分のほかの部分の長さ(囲みの行2つ、言語の指定、改行)。 */
function blockOverhead(fenceLength: number): number {
  return 2 * fenceLength + "diff".length + 2;
}

/** 断り書きのために取っておく長さ。断り書きは、最大で3行、合わせて300文字ほどになる。 */
const NOTES_ROOM = 400;

const WORKSPACE_NOTE = "ファクトリーの作業場所で確かめてください";

/**
 * コメントに載せる、差分の節。行の配列で返す。
 *
 * `budget` は、この節に使える文字数。差分は、コードブロックの中に置く。囲みは、差分の中の
 * バッククォートのどの連続よりも長くするので、差分の中の書き方では閉じられない。コードブロックの
 * 中なので、メンションは通知にならない。切ったことなどの断り書きは、コードブロックの外に書く。
 */
export function diffSection(diff: ProtectedDiff, budget: number): string[] {
  const lines = [
    "保護対象のパスの差分(上のコミットと、既定ブランチと分かれた位置との差分):",
    "",
  ];
  const size = `全体は ${diff.totalChars} 文字、${diff.totalLines} 行です`;
  const notes: string[] = [];
  if (diff.omittedPaths > 0) {
    notes.push(
      `(パスが多いので、差分を取ったのは、上に挙げたパスだけです。ほか ${diff.omittedPaths} 件の差分は、${WORKSPACE_NOTE})`,
    );
  }

  if (diff.text === null) {
    lines.push(`(差分を取得できませんでした。内容は、${WORKSPACE_NOTE})`);
  } else if (budget < HELD_DIFF_MIN_BUDGET) {
    lines.push(
      `(コメントの上限に収まらないので、差分を載せていません。${size}。内容は、${WORKSPACE_NOTE})`,
    );
  } else if (diff.totalChars === 0) {
    lines.push("(差分は空でした)");
  } else {
    // コードブロック(囲みの行2つと差分)に使える長さ。断り書きの分を、先に取っておく。
    const room = budget - NOTES_ROOM;
    const clean = sanitizeDiff(diff.text);
    // 差分の上限と、コードブロックに使える長さは、別に見る。最短の囲みの分は、先に引いておく。
    let shown = cut(
      clean,
      Math.min(HELD_DIFF_LIMIT, room - blockOverhead(MIN_FENCE)),
    );
    if (shown.length + blockOverhead(fenceFor(shown).length) > room) {
      // 囲みが長くなる書き方(バッククォートの長い連続)のときだけ、ここに来る。囲みは、
      // 差分より1文字長いのが最長なので、3分の1まで切れば、必ず収まる。
      shown = cut(clean, Math.floor((room - blockOverhead(1)) / 3));
    }
    const fence = fenceFor(shown);
    lines.push(`${fence}diff`, shown, fence);
    if (diff.truncated || shown.length < clean.length) {
      notes.unshift(
        `(差分が長いので、途中で切りました。${size}。載せたのは、先頭の ${shown.length} 文字です。残りは、${WORKSPACE_NOTE})`,
      );
    }
    if (/^Binary files .* differ$/m.test(shown)) {
      notes.push(`(バイナリの変更は、中身を載せられません。${WORKSPACE_NOTE})`);
    }
  }
  if (notes.length > 0) lines.push("", ...notes);
  return lines;
}
