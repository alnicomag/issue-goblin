/**
 * 製品の Dockerfile の検査。DBにもネットワークにも触れない純粋関数。
 *
 * 起動係は、検査に通った Dockerfile だけをビルドする。ビルドの `RUN` は、ワーカーと同じ
 * 外への経路がないネットワークで動くが、Docker デーモンは、`ADD <URL>` の取得とイメージの取得を、
 * そのネットワークの外で自分で行う。この2つを、本文から起こせないようにする。
 *
 * - `FROM` に書けるのは、基本イメージを表すビルド引数か、前の段の名前だけ。
 * - `COPY` に書けるのは、前の段からのコピーだけ(ビルドコンテキストは渡さない)。
 * - `ADD`、`ONBUILD` などは通さない。
 *
 * 行の読み方は、旧ビルダーに合わせてある。読み方が食い違う余地を減らすために、
 * パーサーへの指示と、紛らわしい空白や制御文字は、どこにあっても通さない。
 */

/** 基本イメージを渡すビルド引数の名前。 */
export const BASE_IMAGE_ARG = "FACTORY_BASE_IMAGE";

/** `FROM` に書ける、基本イメージの表し方。 */
const BASE_IMAGE_REFERENCES: readonly string[] = [
  `\${${BASE_IMAGE_ARG}}`,
  `$${BASE_IMAGE_ARG}`,
];

/** 通す命令。ここにないものは通さない。 */
const ALLOWED_INSTRUCTIONS: ReadonlySet<string> = new Set([
  "FROM",
  "RUN",
  "ENV",
  "ARG",
  "USER",
  "WORKDIR",
  "LABEL",
  "SHELL",
  "CMD",
  "ENTRYPOINT",
  "COPY",
  "EXPOSE",
  "VOLUME",
  "STOPSIGNAL",
  "HEALTHCHECK",
]);

const STAGE_NAME = /^[a-z][a-z0-9_.-]*$/;

/**
 * タブと改行のほかの制御文字と、半角の空白のほかの空白文字。
 * 行の終わりや、命令の区切りの解釈が、この検査と Docker で食い違わないように、通さない。
 */
const CONFUSING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // 制御文字(タブと改行より前)
  [0x0b, 0x1f], // 制御文字(垂直タブ、改ページ、単独の復帰など)
  [0x7f, 0x7f],
  [0x85, 0x85], // 次の行
  [0xa0, 0xa0], // 改行なしの空白
  [0x1680, 0x1680],
  [0x2000, 0x200f], // 幅の違う空白と、幅のない文字
  [0x2028, 0x2029], // 行と段落の区切り
  [0x202f, 0x202f],
  [0x205f, 0x2060],
  [0x3000, 0x3000], // 全角の空白
  [0xfeff, 0xfeff], // BOM
];

function hasConfusingChar(line: string): boolean {
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    if (CONFUSING_RANGES.some(([from, to]) => code >= from && code <= to)) {
      return true;
    }
  }
  return false;
}

const PARSER_DIRECTIVE = /^[ \t]*#[ \t]*(syntax|escape|check)[ \t]*=/i;

const CONTINUATION = /\\[ \t]*$/;

export type DockerfileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface Instruction {
  /** 命令が始まる行(1始まり)。 */
  readonly line: number;
  /** 大文字にした命令の名前。 */
  readonly name: string;
  /** 命令の後ろを、空白で区切ったもの。続きの行は、つないである。 */
  readonly words: readonly string[];
}

function toInstruction(line: number, text: string): Instruction {
  const [name, ...words] = text.split(/[ \t]+/).filter((word) => word !== "");
  return { line, name: (name ?? "").toUpperCase(), words };
}

/**
 * 本文を、命令ごとに分ける。旧ビルダーと同じく、空の行とコメントの行は(続きの途中でも)飛ばし、
 * 行末が `\` なら次の行につなぐ。
 */
function splitInstructions(text: string): Instruction[] {
  const instructions: Instruction[] = [];
  let current: { line: number; text: string } | null = null;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const continued = CONTINUATION.test(line);
    const body = continued ? line.replace(CONTINUATION, "") : line;
    if (current === null) {
      current = { line: index + 1, text: body };
    } else {
      current.text += body;
    }
    if (continued) continue;
    instructions.push(toInstruction(current.line, current.text));
    current = null;
  }
  // 最後の行が `\` で終わっている場合も、そこまでを1つの命令として扱う。
  if (current !== null) {
    instructions.push(toInstruction(current.line, current.text));
  }
  return instructions;
}

/** 製品の Dockerfile を検査する。通らなければ、何行目のどこが理由かを返す。 */
export function checkDockerfile(text: string): DockerfileCheck {
  const normalized = text.replaceAll("\r\n", "\n");
  const fail = (line: number | null, reason: string): DockerfileCheck => ({
    ok: false,
    reason:
      line === null
        ? `Dockerfile を使えません: ${reason}`
        : `Dockerfile を使えません(${line}行目): ${reason}`,
  });

  for (const [index, line] of normalized.split("\n").entries()) {
    if (hasConfusingChar(line)) {
      return fail(
        index + 1,
        "タブと改行のほかの制御文字と、半角の空白のほかの空白文字(全角の空白など)は使えません",
      );
    }
    if (PARSER_DIRECTIVE.test(line)) {
      return fail(
        index + 1,
        "パーサーへの指示(# syntax=、# escape=、# check=)は使えません",
      );
    }
  }

  /** いまの段より前に終わった段の名前。`FROM` と `COPY --from` が指せるのは、これだけ。 */
  const earlierStages: string[] = [];
  /** いまの段の名前。名前がなければ null。 */
  let currentStage: string | null = null;
  let stageCount = 0;

  for (const { line, name, words } of splitInstructions(normalized)) {
    if (!ALLOWED_INSTRUCTIONS.has(name)) {
      return fail(
        line,
        name === "ADD"
          ? "ADD は使えません(ビルドコンテキストは渡されません。取得は RUN で行ってください)"
          : `命令 ${name} は使えません`,
      );
    }
    if (stageCount === 0 && name !== "FROM" && name !== "ARG") {
      return fail(line, "最初の FROM より前に書けるのは、ARG だけです");
    }

    if (name === "FROM") {
      if (currentStage !== null) earlierStages.push(currentStage);
      currentStage = null;
      const [reference, as, stage, ...extra] = words;
      if (reference === undefined) {
        return fail(line, "FROM に、土台がありません");
      }
      if (reference.startsWith("--")) {
        return fail(line, "FROM に、フラグ(--platform など)は付けられません");
      }
      if (
        !BASE_IMAGE_REFERENCES.includes(reference) &&
        !earlierStages.includes(reference.toLowerCase())
      ) {
        return fail(
          line,
          `FROM に書けるのは、\${${BASE_IMAGE_ARG}} か、前の段の名前だけです`,
        );
      }
      if (as !== undefined) {
        if (
          as.toUpperCase() !== "AS" ||
          stage === undefined ||
          extra.length > 0
        ) {
          return fail(line, "FROM を読めません(FROM <土台> AS <段の名前>)");
        }
        const stageName = stage.toLowerCase();
        if (!STAGE_NAME.test(stageName)) {
          return fail(
            line,
            "段の名前に使えるのは、英小文字で始まる、英数字と . _ - だけです",
          );
        }
        if (earlierStages.includes(stageName)) {
          return fail(line, `段の名前 ${stageName} が重なっています`);
        }
        currentStage = stageName;
      }
      stageCount += 1;
      continue;
    }

    if (name === "COPY") {
      const flags: string[] = [];
      for (const word of words) {
        if (!word.startsWith("--")) break;
        flags.push(word);
      }
      const from = flags.filter((flag) =>
        flag.toLowerCase().startsWith("--from"),
      );
      const [only] = from;
      if (from.length !== 1 || only === undefined) {
        return fail(
          line,
          "COPY に書けるのは、前の段からのコピー(--from=<前の段の名前>)だけです。ビルドコンテキストは渡されません",
        );
      }
      const source = /^--from=(.+)$/i.exec(only)?.[1]?.toLowerCase();
      if (source === undefined || !earlierStages.includes(source)) {
        return fail(
          line,
          "COPY の --from に書けるのは、前の段の名前だけです(ほかのイメージからはコピーできません)",
        );
      }
    }
  }

  if (stageCount === 0) {
    return fail(null, "FROM がありません");
  }
  return { ok: true };
}
