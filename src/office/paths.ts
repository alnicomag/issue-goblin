// 変更されたパスを、製品の `factory.yml` の `paths.forbidden` と `paths.protected` に照らす。
//
// ここにある関数は純粋関数で、DBにもネットワークにもファイルにも触れない。
//
// パターンの書き方は、次のものだけに対応する。
//
// | 書き方 | 意味 |
// | --- | --- |
// | `*` | 区切り(`/`)をまたがない、0文字以上 |
// | `?` | 区切りでない1文字 |
// | `**` | 0個以上のディレクトリ。区切りにはさまれた形(`a/**`、`**/a`、`a/**/b`)でだけ書ける |
// | 末尾の `/` | `dir/` は `dir/**` と同じ |
//
// - パターンは、リポジトリの直下からの一致で見る。`CLAUDE.md` は直下のものだけに当たり、
//   どの階層でも当てたいときは `**/CLAUDE.md` と書く。
// - `dir/**` は、`dir` の中のすべてに加えて、`dir` という名前そのもの(ファイルやリンクに
//   差し替えられた場合)にも当たる。
// - 大文字と小文字は区別する。ドットで始まる名前も、`*` に当たる。
// - 対応していない書き方(`[`、`{`、否定の `!` など)は、当たらないものとして通さずに、失敗させる。
//   検査は最後の網なので、読めない規則があるときは、進めない側に倒す。

/** 規則に当たったパスと、当たったパターン。 */
export interface PathHit {
  readonly path: string;
  readonly pattern: string;
}

export interface PathRules {
  readonly forbidden: readonly string[];
  readonly protected: readonly string[];
}

export interface PathCheck {
  /** `forbidden` に当たったパス。 */
  readonly forbidden: readonly PathHit[];
  /** `protected` に当たったパス。`forbidden` にも当たるものは、ここには入れない。 */
  readonly protected: readonly PathHit[];
}

const UNSUPPORTED_CHARS = /[[\]{}\\]/;

/** パターンが、対応していない書き方であることを表すエラー。 */
class GlobPatternError extends Error {
  override readonly name = "GlobPatternError";
}

/** パターンを区切りで分ける。対応していない書き方なら失敗する。 */
function patternSegments(pattern: string): string[] {
  const fail = (reason: string): never => {
    throw new GlobPatternError(
      `パスのパターンを読めません: ${JSON.stringify(pattern)}(${reason})`,
    );
  };
  if (pattern === "") fail("空です");
  if (pattern.startsWith("/")) {
    fail("リポジトリの直下からの相対パスで書いてください");
  }
  if (pattern.startsWith("!")) fail("否定には対応していません");
  if (UNSUPPORTED_CHARS.test(pattern)) {
    fail("使えるのは *、?、** だけです");
  }
  const normalized = pattern.endsWith("/") ? `${pattern}**` : pattern;
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "") fail("区切りが続いています");
    if (segment === "." || segment === "..") {
      fail(". と .. は使えません");
    }
    if (segment !== "**" && segment.includes("**")) {
      fail("** は、区切りにはさまれた形でだけ書けます");
    }
  }
  return segments;
}

/** 区切りを含まない1つの名前が、パターンの1区間に当たるか。 */
function matchSegment(pattern: string, name: string): boolean {
  // 単純な再帰。`*` は0文字以上、`?` は1文字。
  const match = (p: number, n: number): boolean => {
    while (p < pattern.length) {
      const char = pattern[p];
      if (char === "*") {
        // 連続する `*` は1つと同じ。
        while (pattern[p + 1] === "*") p += 1;
        if (p === pattern.length - 1) return true;
        for (let skip = n; skip <= name.length; skip += 1) {
          if (match(p + 1, skip)) return true;
        }
        return false;
      }
      if (n >= name.length) return false;
      if (char !== "?" && char !== name[n]) return false;
      p += 1;
      n += 1;
    }
    return n === name.length;
  };
  return match(0, 0);
}

function matchSegments(
  pattern: readonly string[],
  p: number,
  parts: readonly string[],
  n: number,
): boolean {
  if (p === pattern.length) return n === parts.length;
  const segment = pattern[p] as string;
  if (segment === "**") {
    for (let skip = n; skip <= parts.length; skip += 1) {
      if (matchSegments(pattern, p + 1, parts, skip)) return true;
    }
    return false;
  }
  const part = parts[n];
  if (part === undefined || !matchSegment(segment, part)) return false;
  return matchSegments(pattern, p + 1, parts, n + 1);
}

/**
 * パターンを読めるかを確かめる。読めれば `null`、読めなければ、その理由のメッセージを返す。
 *
 * 照合(`matchGlob`、`checkPaths`)と同じ読み方を使うので、ここで読めるパターンは照合でも読め、
 * ここで読めないパターンは、照合でも同じメッセージで失敗する。
 * `factory.yml` の検証は、これを使って、着手の前に読めないパターンを見つける。
 */
export function globPatternError(pattern: string): string | null {
  try {
    patternSegments(pattern);
    return null;
  } catch (error) {
    if (error instanceof GlobPatternError) return error.message;
    throw error;
  }
}

/**
 * パスがパターンに当たるか。
 *
 * `path` は、リポジトリの直下からの相対パス(区切りは `/`)で渡す。
 * パターンが対応していない書き方なら、失敗する。
 */
export function matchGlob(pattern: string, path: string): boolean {
  return matchSegments(patternSegments(pattern), 0, path.split("/"), 0);
}

/**
 * 変更されたパスを規則に照らす。
 *
 * どのパターンも、パスの有無にかかわらず先に読む。対応していない書き方が1つでもあれば失敗する。
 * 1つのパスが両方に当たる場合は、`forbidden` として扱う。
 */
export function checkPaths(
  paths: readonly string[],
  rules: PathRules,
): PathCheck {
  const compile = (patterns: readonly string[]) =>
    patterns.map((pattern) => ({
      pattern,
      segments: patternSegments(pattern),
    }));
  const forbiddenRules = compile(rules.forbidden);
  const protectedRules = compile(rules.protected);
  const find = (rulesOfKind: ReturnType<typeof compile>, target: string) => {
    const parts = target.split("/");
    return rulesOfKind.find((rule) =>
      matchSegments(rule.segments, 0, parts, 0),
    );
  };

  const forbidden: PathHit[] = [];
  const protectedHits: PathHit[] = [];
  for (const target of paths) {
    const forbiddenRule = find(forbiddenRules, target);
    if (forbiddenRule !== undefined) {
      forbidden.push({ path: target, pattern: forbiddenRule.pattern });
      continue;
    }
    const protectedRule = find(protectedRules, target);
    if (protectedRule !== undefined) {
      protectedHits.push({ path: target, pattern: protectedRule.pattern });
    }
  }
  return { forbidden, protected: protectedHits };
}
