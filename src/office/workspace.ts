/**
 * 製品の作業場所の準備(prepare)と後片付け(cleanup)。
 *
 * | 場所 | 中身 | 見えるのは |
 * | --- | --- | --- |
 * | `<repos_dir>/<owner>/<name>.git` | 事務局専用のミラー | 事務局だけ |
 * | `<work_dir>/<owner>/<name>/issue-<番号>/repo` | イシューごとのclone | 事務局と、そのイシューのワーカー |
 * | `<work_dir>/<owner>/<name>/issue-<番号>/home` | ワーカーのHOME | 同上 |
 *
 * 作業場所は、ワーカーが中身を書き換えられる。事務局がそこでgitを実行するのは、
 * ワーカーが触る前(作るとき)と、ブランチの有無を読むときだけにする。
 *
 * ワーカーのコンテナにはユーザーのgit設定がなく、ワーカーはgitの設定を変えない。
 * コミットの作者は、作るときに事務局がcloneのgit設定に書いておく。
 */
import fs from "node:fs";
import path from "node:path";
import { issueDirFor } from "../launcher/container.ts";
import { isInsideDir } from "./config.ts";
import type { Git, GitAuth } from "./git.ts";

/** 置き場所。ファクトリー側の設定(`repos_dir`、`work_dir`)から渡す。 */
export interface WorkspaceDirs {
  readonly reposDir: string;
  readonly workDir: string;
}

/** 製品リポジトリの取得元。 */
export interface RepoSource {
  readonly url: string;
  /** 取得に使うトークン。gitの実行時にだけ渡し、どこにも保存しない。 */
  readonly token?: string;
}

/** ワーカーのコミットの作者。ファクトリー側の設定(`commit_author`)から渡す。 */
export interface WorkspaceAuthor {
  readonly name: string;
  readonly email: string;
}

export interface WorkspacePaths {
  /** 事務局専用のミラー。 */
  readonly mirrorDir: string;
  /** イシューの作業場所。ワーカーのコンテナには、ここだけをマウントする。 */
  readonly issueDir: string;
  /** 製品のclone。 */
  readonly repoDir: string;
  /** ワーカーのHOME。 */
  readonly homeDir: string;
  /** 作業用のブランチ。 */
  readonly branch: string;
}

export interface PreparedWorkspace extends WorkspacePaths {
  /** 今回の呼び出しでcloneを作ったか。すでにあったものを使った場合は false。 */
  readonly created: boolean;
}

/** 作りかけのcloneを置く名前。できあがってから `repo` に改名する。 */
const PARTIAL_REPO = "repo.partial";

/** 製品リポジトリの、GitHub上の取得元。 */
export function githubSourceUrl(repo: string): string {
  // 形式の検査を兼ねて、パスの組み立てと同じ規則を通す。
  issueDirFor(repo, 1);
  return `https://github.com/${repo}.git`;
}

/** 作業用のブランチの名前。 */
export function branchFor(issue: number): string {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new Error(`イシュー番号が不正です: ${issue}`);
  }
  return `agent/issue-${issue}`;
}

/** `child` が `parent` の内側(同じ場所は含まない)にあることを確かめる。 */
function assertStrictlyInside(parent: string, child: string): void {
  if (child === parent || !isInsideDir(parent, child)) {
    throw new Error(
      `パスが置き場所の外に出ます: ${child}(置き場所: ${parent})`,
    );
  }
}

/**
 * ミラーと作業場所のパスを組み立てる純粋関数。
 *
 * `repo` は設定にある書き方をそのまま渡すこと。リポジトリ名やイシュー番号に細工があって、
 * 置き場所の外に出るパスになる場合は失敗する。作業場所の相対パスは、起動係がマウントするときと
 * 同じ関数(`issueDirFor`)で決める。
 */
export function workspacePaths(
  dirs: WorkspaceDirs,
  repo: string,
  issue: number,
): WorkspacePaths {
  if (!path.isAbsolute(dirs.reposDir) || !path.isAbsolute(dirs.workDir)) {
    throw new Error("置き場所は絶対パスで指定してください");
  }
  const reposDir = path.resolve(dirs.reposDir);
  const workDir = path.resolve(dirs.workDir);
  if (isInsideDir(workDir, reposDir) || isInsideDir(reposDir, workDir)) {
    throw new Error(
      `ミラーの置き場所(${reposDir})と作業場所の置き場所(${workDir})は、別の場所にしてください`,
    );
  }

  const relative = issueDirFor(repo, issue);
  const issueDir = path.resolve(workDir, relative);
  const mirrorDir = path.resolve(
    reposDir,
    `${path.posix.dirname(relative)}.git`,
  );
  // 念のため、組み立てた結果でも確かめる。
  assertStrictlyInside(workDir, issueDir);
  assertStrictlyInside(reposDir, mirrorDir);

  return {
    mirrorDir,
    issueDir,
    repoDir: path.join(issueDir, "repo"),
    homeDir: path.join(issueDir, "home"),
    branch: branchFor(issue),
  };
}

/** そのパスにあるものの種類。シンボリックリンクはたどらない。 */
function kindOf(target: string): "missing" | "directory" | "other" {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return "missing";
  return stat.isDirectory() ? "directory" : "other";
}

function authFor(
  source: RepoSource,
): { auth: GitAuth } | Record<string, never> {
  return source.token === undefined
    ? {}
    : { auth: { url: source.url, token: source.token } };
}

/**
 * ミラーを取得元の最新にして、既定ブランチの名前を返す。
 *
 * 取得元のブランチは `refs/remotes/origin/*` に置く。取得元のURLは毎回引数で渡し、
 * ミラーの設定には残さない。
 */
export async function updateMirror(
  git: Git,
  mirrorDir: string,
  source: RepoSource,
): Promise<string> {
  fs.mkdirSync(path.dirname(mirrorDir), { recursive: true });
  // すでにあるリポジトリに対して行っても、中身は変わらない。
  await git.run(["init", "--quiet", "--bare", "--", mirrorDir]);
  await git.run(
    [
      "fetch",
      "--quiet",
      "--prune",
      "--no-tags",
      "--",
      source.url,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    ],
    { cwd: mirrorDir, ...authFor(source) },
  );

  const listing = await git.run(
    ["ls-remote", "--symref", "--", source.url, "HEAD"],
    { cwd: mirrorDir, ...authFor(source) },
  );
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listing);
  const defaultBranch = match?.[1];
  if (defaultBranch === undefined) {
    throw new Error(`取得元の既定ブランチが分かりません: ${source.url}`);
  }
  const tip = await git.run(
    [
      "for-each-ref",
      "--format=%(objectname)",
      `refs/remotes/origin/${defaultBranch}`,
    ],
    { cwd: mirrorDir },
  );
  if (tip.trim() === "") {
    throw new Error(
      `ミラーに既定ブランチがありません: ${defaultBranch}(${source.url})`,
    );
  }
  return defaultBranch;
}

/** 作業場所のcloneに、ブランチがあるか。読むだけで、何も変えない。 */
export async function hasBranch(
  git: Git,
  repoDir: string,
  branch: string,
): Promise<boolean> {
  const output = await git.run(
    [
      `--git-dir=${path.join(repoDir, ".git")}`,
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${branch}`,
    ],
    { cwd: repoDir },
  );
  return output.split("\n").includes(`refs/heads/${branch}`);
}

/**
 * イシューの作業場所を用意する。
 *
 * 既定ブランチの最新から、ブランチ `agent/issue-<番号>` を持つcloneを作る。
 * やり直して安全で、作業場所がすでにあれば、中身に触れずにそれを使う。
 *
 * コミットの作者(`author`)は、cloneを作るときにだけ、cloneのgit設定に書く。
 * すでにある作業場所には書かないので、後から値を変えても、そこには反映されない。
 *
 * cloneは隣の名前で作り、できあがってから `repo` に改名する。`repo` があれば、
 * 準備は終わっている。途中で止まった場合は、次の呼び出しが作りかけを消して、作り直す。
 */
export async function prepareWorkspace(
  deps: { git: Git },
  input: {
    dirs: WorkspaceDirs;
    repo: string;
    issue: number;
    source: RepoSource;
    author: WorkspaceAuthor;
  },
): Promise<PreparedWorkspace> {
  const { git } = deps;
  const paths = workspacePaths(input.dirs, input.repo, input.issue);

  const existing = kindOf(paths.repoDir);
  if (existing === "other") {
    // ワーカーは `repo` を別の場所へのリンクに差し替えられる。たどらずに失敗させる。
    throw new Error(`作業場所がディレクトリではありません: ${paths.repoDir}`);
  }

  let created = false;
  if (existing === "directory") {
    // `.git` がなかったり、別の場所を指すファイルだったりすると、gitは別のリポジトリを読みにいく。
    if (kindOf(path.join(paths.repoDir, ".git")) !== "directory") {
      throw new Error(
        `作業場所がgitのリポジトリではありません: ${paths.repoDir}`,
      );
    }
    if (!(await hasBranch(git, paths.repoDir, paths.branch))) {
      throw new Error(
        `作業場所にブランチ ${paths.branch} がありません: ${paths.repoDir}(作り直すには、先に後片付けをしてください)`,
      );
    }
  } else {
    const defaultBranch = await updateMirror(
      git,
      paths.mirrorDir,
      input.source,
    );
    const partial = path.join(paths.issueDir, PARTIAL_REPO);
    fs.mkdirSync(paths.issueDir, { recursive: true });
    fs.rmSync(partial, { recursive: true, force: true });

    // clone ではなく init と fetch で作る。リモートの設定が残らず、
    // ミラーのオブジェクトとファイルを共有(ハードリンク)することもない。
    await git.run([
      "init",
      "--quiet",
      `--initial-branch=${paths.branch}`,
      "--",
      partial,
    ]);
    await git.run(
      [
        // reflogには取得元(ミラーのパス)が書かれるので、この取得では記録しない。
        "-c",
        "core.logAllRefUpdates=false",
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        paths.mirrorDir,
        `+refs/remotes/origin/${defaultBranch}:refs/heads/${defaultBranch}`,
        "+refs/tags/*:refs/tags/*",
      ],
      { cwd: partial },
    );
    // 作業用のブランチを、既定ブランチの先頭に作って取り出す。
    await git.run(
      ["reset", "--quiet", "--hard", `refs/heads/${defaultBranch}`],
      {
        cwd: partial,
      },
    );
    // 取得元(ミラーのパス)の記録を残さない。
    fs.rmSync(path.join(partial, ".git", "FETCH_HEAD"), { force: true });
    // ワーカーが設定を足さずにコミットできるように、作者を入れておく。
    for (const [key, value] of [
      ["user.name", input.author.name],
      ["user.email", input.author.email],
    ] as const) {
      await git.run(["config", "--local", "--", key, value], { cwd: partial });
    }

    fs.renameSync(partial, paths.repoDir);
    created = true;
  }

  const home = kindOf(paths.homeDir);
  if (home === "other") {
    throw new Error(
      `ワーカーのHOMEがディレクトリではありません: ${paths.homeDir}`,
    );
  }
  if (home === "missing") fs.mkdirSync(paths.homeDir);

  return { ...paths, created };
}

/**
 * リポジトリの作業場所があるイシューの番号を、若い順に返す。読むだけで、何も変えない。
 *
 * 拾うのは、事務局が作る名前(`issue-<番号>`)だけで、それ以外の名前は無視する。
 * シンボリックリンクはたどらない。リポジトリの置き場所がまだなければ、空を返す。
 */
export function listWorkspaceIssues(
  dirs: WorkspaceDirs,
  repo: string,
): number[] {
  const repoWorkDir = path.dirname(workspacePaths(dirs, repo, 1).issueDir);
  const kind = kindOf(repoWorkDir);
  if (kind === "missing") return [];
  if (kind !== "directory") {
    throw new Error(
      `作業場所の置き場所がディレクトリではありません: ${repoWorkDir}`,
    );
  }
  const issues: number[] = [];
  for (const name of fs.readdirSync(repoWorkDir)) {
    const match = /^issue-([1-9]\d*)$/.exec(name);
    if (match === null) continue;
    const issue = Number(match[1]);
    if (Number.isSafeInteger(issue)) issues.push(issue);
  }
  return issues.sort((a, b) => a - b);
}

/**
 * イシューの作業場所を消す。すでになくても失敗しない。
 *
 * gitは実行しない。シンボリックリンクはたどらずに、リンクそのものを消す。
 * ミラーと、ほかのイシューの作業場所には触れない。
 */
export function cleanupWorkspace(input: {
  dirs: WorkspaceDirs;
  repo: string;
  issue: number;
}): { issueDir: string } {
  const { issueDir } = workspacePaths(input.dirs, input.repo, input.issue);
  fs.rmSync(issueDir, { recursive: true, force: true });
  return { issueDir };
}
