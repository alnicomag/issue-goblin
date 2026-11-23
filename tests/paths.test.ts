import { describe, expect, it } from "vitest";
import {
  checkPaths,
  globPatternError,
  matchGlob,
} from "../src/office/paths.ts";

describe("パスのパターン(matchGlob)", () => {
  const cases: [pattern: string, path: string, expected: boolean][] = [
    // 完全一致。直下からの一致で見る。
    ["CLAUDE.md", "CLAUDE.md", true],
    ["CLAUDE.md", "docs/CLAUDE.md", false],
    ["CLAUDE.md", "CLAUDE.md.bak", false],
    ["CLAUDE.md", "CLAUDE.md/inner", false],
    ["docs/guide.md", "docs/guide.md", true],
    ["docs/guide.md", "docs/sub/guide.md", false],
    // 大文字と小文字は区別する。
    ["CLAUDE.md", "claude.md", false],
    [".github/**", ".GitHub/workflows/ci.yml", false],

    // `*` は区切りをまたがない。
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["docs/*", "docs/a.txt", true],
    ["docs/*", "docs/sub/a.txt", false],
    ["docs/*", "docs", false],
    ["docs/*.md", "docs/a.md", true],
    ["docs/*.md", "docs/a.txt", false],
    ["a*c", "abc", true],
    ["a*c", "ac", true],
    ["a*c", "abcd", false],
    ["a*b*c", "a-b-b-c", true],
    ["*", "anything", true],
    ["*", "dir/anything", false],
    ["*/*.sql", "migrations/001.sql", true],
    ["*/*.sql", "001.sql", false],
    // ドットで始まる名前にも当たる。
    ["*", ".env", true],
    ["config/*", "config/.secret", true],

    // `?` は区切りでない1文字。
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file.txt", false],
    ["file?.txt", "file12.txt", false],
    ["a?b", "a/b", false],

    // 末尾の `**`: 中のすべてと、その名前そのもの。
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", ".github/CODEOWNERS", true],
    [".github/**", ".github", true],
    [".github/**", ".githubx/file", false],
    [".github/**", "sub/.github/file", false],
    // 先頭の `**`: どの階層でも。
    ["**/CLAUDE.md", "CLAUDE.md", true],
    ["**/CLAUDE.md", "a/b/CLAUDE.md", true],
    ["**/CLAUDE.md", "a/CLAUDE.md/b", false],
    ["**/*.sql", "001.sql", true],
    ["**/*.sql", "db/migrations/001.sql", true],
    // 途中の `**`: 0個以上のディレクトリ。
    ["src/**/secret.txt", "src/secret.txt", true],
    ["src/**/secret.txt", "src/a/b/secret.txt", true],
    ["src/**/secret.txt", "lib/a/secret.txt", false],
    ["src/**/gen/**", "src/a/gen/b/c.ts", true],
    ["src/**/gen/**", "src/gen", true],
    // `**` だけなら、すべて。
    ["**", "a", true],
    ["**", "a/b/c", true],

    // 末尾の `/` は、`/**` と同じ。
    ["generated/", "generated/a/b.ts", true],
    ["generated/", "generated", true],
    ["generated/", "generatedx", false],

    // 変わった名前のパス。
    ["docs/**", "docs/名前 with space.md", true],
    ["a b/*", "a b/c", true],
  ];

  it.each(cases)("%s と %s → %s", (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  const unsupported: [pattern: string, reason: string][] = [
    ["", "空"],
    ["/abs/path", "相対パス"],
    ["!docs/**", "否定"],
    ["docs/[ab].md", "*、?、**"],
    ["docs/{a,b}.md", "*、?、**"],
    ["docs\\a.md", "*、?、**"],
    ["docs/**.md", "**"],
    ["a**/b", "**"],
    ["docs//a.md", "区切り"],
    ["../outside", ". と .."],
    ["docs/./a.md", ". と .."],
  ];

  it.each(unsupported)(
    "対応していない書き方 %j は、失敗する",
    (pattern, reason) => {
      expect(() => matchGlob(pattern, "docs/a.md")).toThrow(
        "パスのパターンを読めません",
      );
      expect(() => matchGlob(pattern, "docs/a.md")).toThrow(reason);
    },
  );

  describe("読めるかの判定(globPatternError)", () => {
    it.each(cases)("%s は読める", (pattern) => {
      expect(globPatternError(pattern)).toBeNull();
    });

    it.each(unsupported)(
      "%j は、照合と同じ理由で読めない",
      (pattern, reason) => {
        const message = globPatternError(pattern);
        expect(message).toContain("パスのパターンを読めません");
        expect(message).toContain(JSON.stringify(pattern));
        expect(message).toContain(reason);
        // 照合が投げるメッセージと、同じものを返す。
        expect(() => matchGlob(pattern, "docs/a.md")).toThrow(
          message as string,
        );
        expect(() =>
          checkPaths([], { forbidden: [pattern], protected: [] }),
        ).toThrow(message as string);
      },
    );
  });
});

describe("変更されたパスの検査(checkPaths)", () => {
  const rules = {
    forbidden: ["migrations/**", "**/*.lock"],
    protected: [".github/**", "CLAUDE.md", "migrations/**", "config/*"],
  };

  it("どちらにも当たらなければ、空で返す", () => {
    expect(checkPaths(["src/a.ts", "docs/CLAUDE.md"], rules)).toEqual({
      forbidden: [],
      protected: [],
    });
  });

  it("当たったパスを、パターンとあわせて種類ごとに返す", () => {
    expect(
      checkPaths(
        [
          "src/a.ts",
          ".github/workflows/ci.yml",
          "migrations/002.sql",
          "CLAUDE.md",
          "deep/dir/pnpm.lock",
        ],
        rules,
      ),
    ).toEqual({
      forbidden: [
        { path: "migrations/002.sql", pattern: "migrations/**" },
        { path: "deep/dir/pnpm.lock", pattern: "**/*.lock" },
      ],
      protected: [
        { path: ".github/workflows/ci.yml", pattern: ".github/**" },
        { path: "CLAUDE.md", pattern: "CLAUDE.md" },
      ],
    });
  });

  it("両方に当たるパスは、forbidden として扱う", () => {
    const result = checkPaths(["migrations/003.sql", "config/a.lock"], rules);
    expect(result.forbidden.map((hit) => hit.path)).toEqual([
      "migrations/003.sql",
      "config/a.lock",
    ]);
    expect(result.protected).toEqual([]);
  });

  it("規則が空なら、何にも当たらない", () => {
    expect(
      checkPaths([".github/x", "a"], { forbidden: [], protected: [] }),
    ).toEqual({ forbidden: [], protected: [] });
  });

  it("読めないパターンがあれば、パスが1つもなくても失敗する", () => {
    expect(() =>
      checkPaths([], { forbidden: [], protected: ["docs/[a].md"] }),
    ).toThrow("パスのパターンを読めません");
    expect(() =>
      checkPaths(["src/a.ts"], { forbidden: ["!keep"], protected: [] }),
    ).toThrow("否定");
  });
});
