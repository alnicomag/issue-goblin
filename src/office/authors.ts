/**
 * コミットの作者の検査。
 *
 * ワーカーは、作業場所のgit設定、環境変数、`git commit --author` で、作者を自由に変えられる。
 * 事務局は、取り込んだコミットそのものに書かれた作者(author)とコミッター(committer)を読み、
 * ファクトリー側の設定(`commit_author`)と一致するかを確かめる。
 *
 * ここにあるのは純粋関数だけで、DBにもネットワークにもgitにも触れない。
 */

/** コミットに書かれた、名前とメールアドレス。 */
export interface Identity {
  readonly name: string;
  readonly email: string;
}

/** コミット1つ分の、作者とコミッター。 */
export interface CommitIdentity {
  /** コミットのハッシュ。 */
  readonly commit: string;
  readonly author: Identity;
  readonly committer: Identity;
}

/**
 * コミットの作者を読むための `git log` の書式。`-z` と合わせて使う。
 *
 * ハッシュ、作者の名前とメール、コミッターの名前とメールを、NULで区切って出す。
 * `.mailmap` による読み替えをしない書き方(`%an` など)を使う。
 */
export const COMMIT_IDENTITY_FORMAT = "tformat:%H%x00%an%x00%ae%x00%cn%x00%ce";

const FIELDS_PER_COMMIT = 5;
const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `git log -z --format=<COMMIT_IDENTITY_FORMAT>` の出力を、コミットごとに分ける。
 *
 * 手で作ったコミットは、作者の欄に区切りの文字を仕込める。欄の数やハッシュの形が合わない出力は、
 * 読めたところまでで済ませずに、失敗させる。コミットの数が合っているかは、呼ぶ側が確かめる。
 */
export function parseCommitIdentities(output: string): CommitIdentity[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) {
    throw new Error("コミットの一覧を読めません: 終わりの区切りがありません");
  }
  const fields = output.slice(0, -1).split("\0");
  if (fields.length % FIELDS_PER_COMMIT !== 0) {
    throw new Error(
      `コミットの一覧を読めません: 欄の数(${fields.length})が、コミットごとに${FIELDS_PER_COMMIT}つになっていません`,
    );
  }
  const commits: CommitIdentity[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < fields.length; index += FIELDS_PER_COMMIT) {
    const [commit, authorName, authorEmail, committerName, committerEmail] =
      fields.slice(index, index + FIELDS_PER_COMMIT) as [
        string,
        string,
        string,
        string,
        string,
      ];
    if (!HASH_PATTERN.test(commit)) {
      throw new Error(
        `コミットの一覧を読めません: ハッシュの形ではありません: ${JSON.stringify(commit.slice(0, 80))}`,
      );
    }
    if (seen.has(commit)) {
      throw new Error(
        `コミットの一覧を読めません: 同じコミットが2回あります: ${commit}`,
      );
    }
    seen.add(commit);
    commits.push({
      commit,
      author: { name: authorName, email: authorEmail },
      committer: { name: committerName, email: committerEmail },
    });
  }
  return commits;
}

function sameIdentity(actual: Identity, expected: Identity): boolean {
  return actual.name === expected.name && actual.email === expected.email;
}

/**
 * 作者かコミッターが `expected` と一致しないコミットを返す。すべて一致すれば、空の配列を返す。
 *
 * 名前とメールアドレスの両方を、文字列として完全に一致するかで比べる。
 * 大文字と小文字、前後の空白も区別する。
 */
export function checkCommitAuthors(
  commits: readonly CommitIdentity[],
  expected: Identity,
): CommitIdentity[] {
  return commits.filter(
    (entry) =>
      !sameIdentity(entry.author, expected) ||
      !sameIdentity(entry.committer, expected),
  );
}
