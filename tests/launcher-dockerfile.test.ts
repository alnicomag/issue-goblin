import { describe, expect, it } from "vitest";
import { checkDockerfile } from "../src/launcher/dockerfile.ts";

const BASE = `ARG FACTORY_BASE_IMAGE\nFROM \${FACTORY_BASE_IMAGE}\n`;

const reasonOf = (text: string): string => {
  const result = checkDockerfile(text);
  if (result.ok) throw new Error("検査に通ってしまいました");
  return result.reason;
};

describe("製品の Dockerfile の検査", () => {
  it.each([
    ["基本イメージだけ", BASE],
    [
      "波かっこなしの書き方",
      "ARG FACTORY_BASE_IMAGE\nFROM $FACTORY_BASE_IMAGE\n",
    ],
    [
      "ツールを入れて、ユーザーを戻す",
      `${BASE}USER root\nRUN example-install --yes tool \\\n  && example-cleanup\nENV EXAMPLE=1\nUSER node\n`,
    ],
    [
      "コメント、空の行、CRLF",
      `# ワーカーのイメージに、ツールを足す\r\n\r\n${BASE.replaceAll("\n", "\r\n")}RUN true\r\n`,
    ],
    [
      "続きの途中のコメントと空の行",
      `${BASE}RUN first \\\n  # 途中のコメント\n\n  && second\n`,
    ],
    [
      "前の段からのコピー",
      `${BASE.replace("}\n", "} AS build\n")}RUN example-build\nFROM \${FACTORY_BASE_IMAGE}\nCOPY --chown=node:node --from=build /out /usr/local/bin/\n`,
    ],
    [
      "前の段を土台にする",
      `${BASE.replace("}\n", "} AS Tools\n")}RUN true\nFROM tools AS final\nRUN true\n`,
    ],
    [
      "小文字の命令",
      `arg FACTORY_BASE_IMAGE\nfrom \${FACTORY_BASE_IMAGE}\nrun true\n`,
    ],
    [
      "そのほかの命令",
      `${BASE}WORKDIR /workspace\nLABEL a=b\nSHELL ["/bin/sh", "-c"]\nEXPOSE 8080\nVOLUME /cache\nSTOPSIGNAL SIGTERM\nHEALTHCHECK NONE\nENTRYPOINT ["example"]\nCMD ["--help"]\n`,
    ],
  ])("%s は通る", (_name, text) => {
    expect(checkDockerfile(text)).toEqual({ ok: true });
  });

  it.each([
    ["ほかのイメージ", "FROM example/image:1\n", "1行目", "FROM に書けるのは"],
    [
      "基本イメージに似せた書き方",
      `ARG FACTORY_BASE_IMAGE\nFROM \${FACTORY_BASE_IMAGE}-other\n`,
      "2行目",
      "FROM に書けるのは",
    ],
    [
      "ほかの引数",
      "ARG OTHER=example/image\nFROM ${OTHER}\n",
      "2行目",
      "FROM に書けるのは",
    ],
    [
      "既定値つきの引数の展開",
      `FROM \${FACTORY_BASE_IMAGE:-example/image}\n`,
      "1行目",
      "FROM に書けるのは",
    ],
    [
      "2つ目の段のほかのイメージ",
      `${BASE}FROM example/image AS extra\n`,
      "3行目",
      "FROM に書けるのは",
    ],
    [
      "後ろの段の名前",
      `FROM later\nFROM \${FACTORY_BASE_IMAGE} AS later\n`,
      "1行目",
      "FROM に書けるのは",
    ],
    [
      "自分自身の段の名前",
      `${BASE}FROM self AS self\n`,
      "3行目",
      "FROM に書けるのは",
    ],
    [
      "FROM のフラグ",
      `FROM --platform=linux/amd64 \${FACTORY_BASE_IMAGE}\n`,
      "1行目",
      "フラグ",
    ],
    ["土台のない FROM", "FROM\n", "1行目", "土台がありません"],
    [
      "読めない FROM",
      `FROM \${FACTORY_BASE_IMAGE} build\n`,
      "1行目",
      "FROM を読めません",
    ],
    [
      "余分な語のある FROM",
      `FROM \${FACTORY_BASE_IMAGE} AS build extra\n`,
      "1行目",
      "FROM を読めません",
    ],
    [
      "使えない段の名前",
      `FROM \${FACTORY_BASE_IMAGE} AS example/image\n`,
      "1行目",
      "段の名前に使えるのは",
    ],
    [
      "重なった段の名前",
      `FROM \${FACTORY_BASE_IMAGE} AS a\nFROM \${FACTORY_BASE_IMAGE} AS b\nFROM a AS A\n`,
      "3行目",
      "重なっています",
    ],
    [
      "ADD(URL)",
      `${BASE}ADD https://example.invalid/tool /tool\n`,
      "3行目",
      "ADD は使えません",
    ],
    ["ADD(ファイル)", `${BASE}add tool /tool\n`, "3行目", "ADD は使えません"],
    [
      "続きの行に隠した ADD",
      `${BASE}RUN true\n\nADD https://example.invalid/tool /tool\n`,
      "5行目",
      "ADD は使えません",
    ],
    [
      "ONBUILD",
      `${BASE}ONBUILD ADD https://example.invalid/tool /tool\n`,
      "3行目",
      "命令 ONBUILD は使えません",
    ],
    ["MAINTAINER", `${BASE}MAINTAINER someone\n`, "3行目", "命令 MAINTAINER"],
    ["知らない命令", `${BASE}INCLUDE other\n`, "3行目", "命令 INCLUDE"],
    [
      "コンテキストからの COPY",
      `${BASE}COPY tool /usr/local/bin/tool\n`,
      "3行目",
      "ビルドコンテキストは渡されません",
    ],
    [
      "ほかのイメージからの COPY",
      `${BASE}COPY --from=example/image /tool /tool\n`,
      "3行目",
      "前の段の名前だけです",
    ],
    [
      "自分の段からの COPY",
      `${BASE.replace("}\n", "} AS build\n")}COPY --from=build /a /b\n`,
      "3行目",
      "前の段の名前だけです",
    ],
    [
      "番号で指す COPY",
      `${BASE}FROM \${FACTORY_BASE_IMAGE}\nCOPY --from=0 /a /b\n`,
      "4行目",
      "前の段の名前だけです",
    ],
    [
      "引数で指す COPY",
      `${BASE.replace("}\n", "} AS build\n")}FROM build\nARG SRC=example/image\nCOPY --from=$SRC /a /b\n`,
      "5行目",
      "前の段の名前だけです",
    ],
    [
      "--from が2つある COPY",
      `${BASE.replace("}\n", "} AS build\n")}FROM build\nCOPY --from=build --from=example/image /a /b\n`,
      "4行目",
      "COPY に書けるのは",
    ],
    [
      "値のない --from",
      `${BASE.replace("}\n", "} AS build\n")}FROM build\nCOPY --from /a /b\n`,
      "4行目",
      "前の段の名前だけです",
    ],
    [
      "FROM より前の命令",
      `RUN true\nFROM \${FACTORY_BASE_IMAGE}\n`,
      "1行目",
      "最初の FROM より前に書けるのは",
    ],
    [
      "# syntax=",
      `# syntax=example/frontend\n${BASE}`,
      "1行目",
      "パーサーへの指示",
    ],
    ["# escape=", `#escape=\`\n${BASE}`, "1行目", "パーサーへの指示"],
    [
      "途中にある # check=",
      `${BASE}  # Check = skip=all\n`,
      "3行目",
      "パーサーへの指示",
    ],
    ["NUL文字", `${BASE}RUN true\0\n`, "3行目", "制御文字"],
    ["単独の CR", `${BASE}RUN true \\\rADD x y\n`, "3行目", "制御文字"],
    ["全角の空白", `${BASE}RUN true \\\u3000\nADD x y\n`, "3行目", "空白文字"],
    ["改行なしの空白", `${BASE}ADD\u00a0x y\n`, "3行目", "空白文字"],
    ["垂直タブ", `${BASE}RUN true\u000bADD x y\n`, "3行目", "制御文字"],
  ])("%s は通らない", (_name, text, line, reason) => {
    const message = reasonOf(text);
    expect(message).toContain(line);
    expect(message).toContain(reason);
  });

  it("FROM がなければ通らない", () => {
    expect(reasonOf("")).toBe("Dockerfile を使えません: FROM がありません");
    expect(reasonOf("# コメントだけ\nARG A=1\n")).toContain(
      "FROM がありません",
    );
  });

  it("行末の \\ でつないだ行は、1つの命令として読む", () => {
    // ADD に見える行は、RUN の続きなので、命令ではない。
    expect(
      checkDockerfile(`${BASE}RUN echo \\\nADD https://example.invalid /x\n`),
    ).toEqual({ ok: true });
    // \ の後ろに空白があっても、続きとして読む(Docker と同じ)。
    expect(
      checkDockerfile(
        `${BASE}RUN echo \\ \t\nADD https://example.invalid /x\n`,
      ),
    ).toEqual({ ok: true });
    // 続きが終わった後の ADD は、命令として読む。
    expect(
      reasonOf(`${BASE}RUN echo \\\n  done\nADD https://example.invalid /x\n`),
    ).toContain("5行目");
  });
});
