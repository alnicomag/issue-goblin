import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatRevision,
  parseRevision,
  revisionFromEnv,
} from "../src/office/revision.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("イメージの目印", () => {
  it("コミットと、未コミットの変更の印だけを通す", () => {
    expect(parseRevision(COMMIT)).toBe(COMMIT);
    expect(parseRevision(`${COMMIT}-dirty`)).toBe(`${COMMIT}-dirty`);
    expect(parseRevision(` ${COMMIT}\n`)).toBe(COMMIT);
  });

  it("値がない場合と、目印の形でない場合は、不明にする", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "unknown",
      "main",
      COMMIT.slice(0, 12),
      `${COMMIT}-dirty-extra`,
      `${COMMIT} dummy-token-value`,
      COMMIT.toUpperCase(),
      42,
    ]) {
      expect(parseRevision(raw)).toBeNull();
    }
  });

  it("環境変数から、自分のイメージの目印を読む", () => {
    expect(revisionFromEnv({ FACTORY_REVISION: COMMIT })).toBe(COMMIT);
    expect(revisionFromEnv({ FACTORY_REVISION: "" })).toBeNull();
    expect(revisionFromEnv({})).toBeNull();
  });

  it("表示では短くし、未コミットの変更と、不明が分かる", () => {
    expect(formatRevision(COMMIT)).toBe("0123456789ab");
    expect(formatRevision(`${COMMIT}-dirty`)).toBe(
      "0123456789ab(未コミットの変更あり)",
    );
    expect(formatRevision(null)).toBe("不明");
  });
});

describe("目印を出すスクリプト", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** スクリプトを写した、コミットが1つあるリポジトリを作る。 */
  function repoWithScript(): {
    dir: string;
    git: (...args: string[]) => string;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revision-test-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
      }).trim();
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(
      path.join(import.meta.dirname, "../scripts/revision.sh"),
      path.join(dir, "scripts/revision.sh"),
    );
    fs.chmodSync(path.join(dir, "scripts/revision.sh"), 0o755);
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
    git("init", "--quiet");
    git("add", ".");
    git("commit", "--quiet", "-m", "init");
    return { dir, git };
  }

  function run(dir: string): string {
    // 別のディレクトリから呼んでも、スクリプトのあるリポジトリを見る。
    return execFileSync(path.join(dir, "scripts/revision.sh"), {
      cwd: os.tmpdir(),
      encoding: "utf8",
    }).trim();
  }

  it("変更がなければ、HEAD のコミットを出す", () => {
    const { dir, git } = repoWithScript();
    const output = run(dir);
    expect(output).toBe(git("rev-parse", "HEAD"));
    expect(parseRevision(output)).toBe(output);
  });

  it("未コミットの変更があれば、-dirty を付ける", () => {
    const { dir, git } = repoWithScript();
    fs.writeFileSync(path.join(dir, "file.txt"), "two\n");
    const output = run(dir);
    expect(output).toBe(`${git("rev-parse", "HEAD")}-dirty`);
    expect(parseRevision(output)).toBe(output);
  });

  it("未追跡のファイルも変更として数え、無視されているファイルは数えない", () => {
    const { dir, git } = repoWithScript();
    fs.writeFileSync(path.join(dir, "ignored.txt"), "x\n");
    expect(run(dir)).toBe(git("rev-parse", "HEAD"));
    fs.writeFileSync(path.join(dir, "new.txt"), "x\n");
    expect(run(dir)).toBe(`${git("rev-parse", "HEAD")}-dirty`);
  });
});
