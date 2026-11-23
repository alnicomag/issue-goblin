/**
 * publish: ワーカーのコミットを確かめ、push してPRにする。
 *
 * ワーカーの申告には頼らない。事務局が、作業場所のcloneから事務局専用のミラーにコミットを取り込み、
 * ミラーで既定ブランチとの差分を調べる。push はミラーから行う。
 *
 * 作業場所はワーカーが書き換えられる。そこにあるフックやgit設定で、事務局の権限のまま
 * コマンドが動かないように、gitは `git.ts` を通して実行する。差分の検査も、作業場所ではなく
 * ミラーで行う。
 */
import fs from "node:fs";
import type { Git } from "./git.ts";
import { hasBranch, type WorkspacePaths } from "./workspace.ts";

/** そのパスが、本物のディレクトリか。シンボリックリンクはたどらない。 */
function isRealDir(target: string): boolean {
  return (
    fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true
  );
}

/**
 * 作業場所のcloneから、作業用のブランチをミラーに取り込む。
 *
 * 取り込んだブランチの先頭のコミットを返す。作業場所にブランチがなければ null を返す。
 * ミラーは、先に `updateMirror` で用意しておくこと。
 *
 * 取り込みは、ミラーの側で `git fetch` を実行して行う。作業場所の側のフックは動かず、
 * 作業場所のgit設定にある、コマンドを起動する項目も効かない。`repo` や `.git` が
 * 別の場所へのリンクに差し替えられている場合は、たどらずに失敗させる。
 * トークンは渡さない。
 */
export async function importCommits(
  git: Git,
  paths: Pick<WorkspacePaths, "mirrorDir" | "repoDir" | "branch">,
): Promise<string | null> {
  const { mirrorDir, repoDir, branch } = paths;
  if (!isRealDir(repoDir) || !isRealDir(`${repoDir}/.git`)) {
    throw new Error(
      `作業場所がgitのリポジトリではありません: ${repoDir}(cloneがないか、リンクに差し替えられています)`,
    );
  }
  if (!isRealDir(mirrorDir)) {
    throw new Error(`ミラーがありません: ${mirrorDir}`);
  }
  if (!(await hasBranch(git, repoDir, branch))) return null;

  const ref = `refs/heads/${branch}`;
  await git.run(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      // 取得元(作業場所のパス)の記録を、ミラーに残さない。
      "--no-write-fetch-head",
      "--",
      repoDir,
      `+${ref}:${ref}`,
    ],
    { cwd: mirrorDir },
  );
  const head = await git.run(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: mirrorDir },
  );
  return head.trim();
}

/** 既定ブランチと比べた、作業用のブランチの変更。 */
export interface BranchChanges {
  /** 作業用のブランチの先頭。 */
  readonly headCommit: string;
  /** 既定ブランチと分かれた位置。差分の基準にする。 */
  readonly mergeBase: string;
  /** 既定ブランチにない、作業用のブランチのコミットの数。 */
  readonly commitCount: number;
  /**
   * 変更されたパス(リポジトリの直下からの相対パス)。
   * 改名は、消したパスと足したパスの両方として現れる。
   */
  readonly paths: readonly string[];
}

/**
 * ミラーで、作業用のブランチと既定ブランチの差分を調べる。読むだけで、何も変えない。
 *
 * 差分は、PRに現れるものと同じく、既定ブランチと分かれた位置からのものにする。
 */
export async function inspectChanges(
  git: Git,
  input: { mirrorDir: string; branch: string; defaultBranch: string },
): Promise<BranchChanges> {
  const { mirrorDir } = input;
  const run = async (args: string[]) =>
    (await git.run(args, { cwd: mirrorDir })).trim();
  const base = `refs/remotes/origin/${input.defaultBranch}`;
  const head = `refs/heads/${input.branch}`;

  const headCommit = await run([
    "rev-parse",
    "--verify",
    "--quiet",
    `${head}^{commit}`,
  ]);
  let mergeBase: string;
  try {
    mergeBase = await run(["merge-base", base, head]);
  } catch (error) {
    throw new Error(
      `ブランチ ${input.branch} は、既定ブランチ ${input.defaultBranch} と履歴がつながっていません`,
      { cause: error },
    );
  }
  const count = await run(["rev-list", "--count", `${base}..${head}`]);
  const commitCount = Number.parseInt(count, 10);
  if (!Number.isSafeInteger(commitCount)) {
    throw new Error(`コミットの数を読めません: ${count}`);
  }
  const listing = await git.run(
    [
      "diff",
      "--name-only",
      "-z",
      // 改名として1つにまとめず、消したパスと足したパスの両方を出させる。
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      mergeBase,
      headCommit,
      "--",
    ],
    { cwd: mirrorDir },
  );
  return {
    headCommit,
    mergeBase,
    commitCount,
    paths: listing.split("\0").filter((entry) => entry !== ""),
  };
}
