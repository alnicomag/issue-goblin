import { describe, expect, it } from "vitest";
import {
  type CommitIdentity,
  checkCommitAuthors,
  type Identity,
  parseCommitIdentities,
} from "../src/office/authors.ts";

const EXPECTED: Identity = {
  name: "Example Worker",
  email: "worker@example.invalid",
};
const OTHER: Identity = {
  name: "Someone Else",
  email: "someone@example.invalid",
};
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);

const commit = (
  hash: string,
  author: Identity = EXPECTED,
  committer: Identity = EXPECTED,
): CommitIdentity => ({ commit: hash, author, committer });

/** `git log -z` の出力と同じ形にする。 */
const record = (entry: CommitIdentity): string =>
  `${[
    entry.commit,
    entry.author.name,
    entry.author.email,
    entry.committer.name,
    entry.committer.email,
  ].join("\0")}\0`;

describe("コミットの作者の検査(checkCommitAuthors)", () => {
  it("すべてのコミットの作者とコミッターが一致すれば、通る", () => {
    expect(
      checkCommitAuthors(
        [commit(HASH_A), commit(HASH_B), commit(HASH_C)],
        EXPECTED,
      ),
    ).toEqual([]);
  });

  it("コミットがなければ、通る", () => {
    expect(checkCommitAuthors([], EXPECTED)).toEqual([]);
  });

  it("作者だけが違うコミットを却下する", () => {
    const bad = commit(HASH_A, OTHER, EXPECTED);
    expect(checkCommitAuthors([bad], EXPECTED)).toEqual([bad]);
  });

  it("コミッターだけが違うコミットを却下する", () => {
    const bad = commit(HASH_A, EXPECTED, OTHER);
    expect(checkCommitAuthors([bad], EXPECTED)).toEqual([bad]);
  });

  it("名前だけが違うコミットを却下する", () => {
    const renamed = { ...EXPECTED, name: OTHER.name };
    const asAuthor = commit(HASH_A, renamed, EXPECTED);
    const asCommitter = commit(HASH_B, EXPECTED, renamed);
    expect(checkCommitAuthors([asAuthor, asCommitter], EXPECTED)).toEqual([
      asAuthor,
      asCommitter,
    ]);
  });

  it("メールアドレスだけが違うコミットを却下する", () => {
    const readdressed = { ...EXPECTED, email: OTHER.email };
    const asAuthor = commit(HASH_A, readdressed, EXPECTED);
    const asCommitter = commit(HASH_B, EXPECTED, readdressed);
    expect(checkCommitAuthors([asAuthor, asCommitter], EXPECTED)).toEqual([
      asAuthor,
      asCommitter,
    ]);
  });

  it("複数のコミットのうち1つだけが違う場合も、そのコミットを却下する", () => {
    const bad = commit(HASH_B, OTHER, EXPECTED);
    expect(
      checkCommitAuthors([commit(HASH_A), bad, commit(HASH_C)], EXPECTED),
    ).toEqual([bad]);
  });

  it("大文字と小文字、前後の空白の違いも、一致とみなさない", () => {
    const variants: Identity[] = [
      { ...EXPECTED, name: EXPECTED.name.toLowerCase() },
      { ...EXPECTED, name: `${EXPECTED.name} ` },
      { ...EXPECTED, email: EXPECTED.email.toUpperCase() },
      { ...EXPECTED, name: "" },
      { ...EXPECTED, email: "" },
    ];
    for (const variant of variants) {
      expect(
        checkCommitAuthors([commit(HASH_A, variant, EXPECTED)], EXPECTED),
      ).toHaveLength(1);
    }
  });
});

describe("コミットの一覧の読み取り(parseCommitIdentities)", () => {
  it("コミットごとに、ハッシュ、作者、コミッターに分ける", () => {
    const commits = [commit(HASH_A), commit(HASH_B, OTHER, EXPECTED)];
    expect(parseCommitIdentities(commits.map(record).join(""))).toEqual(
      commits,
    );
  });

  it("空の出力は、コミットなしとして読む", () => {
    expect(parseCommitIdentities("")).toEqual([]);
  });

  it("空の名前やメールアドレスも、そのまま読む", () => {
    const empty = commit(HASH_A, { name: "", email: "" }, EXPECTED);
    expect(parseCommitIdentities(record(empty))).toEqual([empty]);
  });

  it("改行を含む名前を、コミットの区切りとして読まない", () => {
    const tricky = commit(
      HASH_A,
      { name: `Example\n${HASH_B}`, email: EXPECTED.email },
      EXPECTED,
    );
    expect(parseCommitIdentities(record(tricky))).toEqual([tricky]);
  });

  it("SHA-256のハッシュも読む", () => {
    const long = commit("d".repeat(64));
    expect(parseCommitIdentities(record(long))).toEqual([long]);
  });

  it("欄の数が合わなければ、失敗する", () => {
    expect(() =>
      parseCommitIdentities(`${HASH_A}\0${EXPECTED.name}\0${EXPECTED.email}\0`),
    ).toThrow("欄の数");
    // 作者の欄にNULを仕込んで、欄を1つ増やした場合。
    expect(() =>
      parseCommitIdentities(
        record(commit(HASH_A, { name: "a\0b", email: "c" }, EXPECTED)),
      ),
    ).toThrow("欄の数");
  });

  it("終わりの区切りがなければ、失敗する", () => {
    expect(() =>
      parseCommitIdentities(record(commit(HASH_A)).slice(0, -1)),
    ).toThrow("終わりの区切り");
  });

  it("ハッシュの位置にハッシュでないものがあれば、失敗する", () => {
    expect(() => parseCommitIdentities(record(commit("not-a-hash")))).toThrow(
      "ハッシュの形ではありません",
    );
  });

  it("同じコミットが2回あれば、失敗する", () => {
    expect(() =>
      parseCommitIdentities(record(commit(HASH_A)) + record(commit(HASH_A))),
    ).toThrow("同じコミットが2回");
  });
});
