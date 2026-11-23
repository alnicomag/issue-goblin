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
import type { Db } from "./db.ts";
import type { Git } from "./git.ts";
import {
  createPullRequest,
  FACTORY_MARKER,
  pushBranch,
  updatePullRequest,
  type WriteContext,
} from "./github.ts";
import { checkPaths, type PathHit } from "./paths.ts";
import { readStoredFactoryYml } from "./product.ts";
import {
  hasBranch,
  type RepoSource,
  updateMirror,
  type WorkspaceDirs,
  type WorkspacePaths,
  workspacePaths,
} from "./workspace.ts";

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

// ---------------------------------------------------------------------------
// PRの内容
// ---------------------------------------------------------------------------

/** PRの本文に載せる、verify の結果。`VerifyResult` をそのまま渡せる。 */
export interface PublishVerifySummary {
  readonly passed: boolean;
  readonly commands: readonly {
    readonly name: string;
    readonly status: string;
    readonly exitCode: number | null;
  }[];
}

const VERIFY_STATUS_LABELS: Readonly<Record<string, string>> = {
  passed: "合格",
  failed: "不合格",
  timed_out: "時間切れ",
  not_run: "実行できず",
  skipped: "実行せず",
};

/** 1行に収める。表や箇条書きを崩す文字を除く。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** PRのタイトル。イシューのタイトルを1行にして使う。空なら、番号から作る。 */
export function buildPrTitle(issue: number, issueTitle: string): string {
  const title = oneLine(issueTitle);
  return title === "" ? `Issue #${issue}` : title;
}

/**
 * PRの本文を組み立てる純粋関数。
 *
 * 対応イシュー(マージでイシューが閉じる書き方)、検証結果、ワーカーの環境では確かめられない範囲
 * (`verify.unverified`)を書き、末尾に目印を付ける。検査コマンドの出力は載せない。
 */
export function buildPrBody(input: {
  issue: number;
  verify: PublishVerifySummary | null;
  unverified: readonly string[];
}): string {
  const lines = [`Closes #${input.issue}`, "", "## 検証結果", ""];
  if (input.verify === null) {
    lines.push("検証結果の記録がありません。");
  } else {
    lines.push(
      input.verify.passed
        ? "事務局が実行した検査コマンドは、すべて通りました。"
        : "事務局が実行した検査コマンドに、通らなかったものがあります。",
      "",
      "| コマンド | 結果 | 終了コード |",
      "| --- | --- | --- |",
    );
    for (const command of input.verify.commands) {
      const label = VERIFY_STATUS_LABELS[command.status] ?? command.status;
      const exitCode = command.exitCode === null ? "-" : `${command.exitCode}`;
      lines.push(
        `| \`${oneLine(command.name)}\` | ${oneLine(label)} | ${exitCode} |`,
      );
    }
  }
  lines.push("", "## 未検証の範囲", "");
  if (input.unverified.length === 0) {
    lines.push("なし");
  } else {
    lines.push(
      "次の範囲は、ワーカーの環境では確かめていません。人間の確認が要ります。",
      "",
      ...input.unverified.map((entry) => `- ${oneLine(entry)}`),
    );
  }
  lines.push("", FACTORY_MARKER, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

/**
 * publish の結果の種類。
 *
 * - `published`: push して、PRを作った(または更新した)。
 * - `dry_run`: 検査は通ったが、`dry_run` なので push もPRの作成もしていない。
 * - `no_commits`: ワーカーのコミットがない(ブランチがない場合を含む)。
 * - `empty_diff`: コミットはあるが、既定ブランチとの差分が空。
 * - `forbidden`: `paths.forbidden` に当たる変更がある。push していない。
 * - `needs_approval`: `paths.protected` に当たる変更がある。push しておらず、人間の承認待ち。
 */
export type PublishStatus =
  | "published"
  | "dry_run"
  | "no_commits"
  | "empty_diff"
  | "forbidden"
  | "needs_approval";

/** publish の結果。チェックポイント(`steps.output`)に残せる形にしてある。 */
export interface PublishResult {
  readonly status: PublishStatus;
  /** ステップの結果。`published` と `dry_run` だけが `done`。 */
  readonly outcome: "done" | "failed";
  /** 人間の承認があれば進められる状態か(`needs_approval` のときだけ true)。 */
  readonly awaitingApproval: boolean;
  readonly summary: string;
  readonly branch: string;
  /** 既定ブランチ。PRの取り込み先。 */
  readonly baseBranch: string;
  /** 取り込んだブランチの先頭。ブランチがなければ null。 */
  readonly headCommit: string | null;
  readonly changedPaths: readonly string[];
  readonly forbidden: readonly PathHit[];
  readonly protected: readonly PathHit[];
  /** PRの番号。作っていなければ null(`dry_run` で、既存のPRがあればその番号)。 */
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  /** 今回の呼び出しでPRを作ったか。既存のPRを更新した場合は false。 */
  readonly prCreated: boolean;
}

export interface PublishDeps {
  readonly db: Db;
  /** gitの実行。`git.ts` のものを渡す。 */
  readonly git: Git;
  /** GitHubへの書き込みの口と、`dry_run`。 */
  readonly write: WriteContext;
  /** 置き場所(設定の `repos_dir`、`work_dir`)。 */
  readonly dirs: WorkspaceDirs;
}

export interface PublishInput {
  /** 対象のリポジトリ(owner/name)。設定にある書き方で渡す。 */
  readonly repo: string;
  readonly issue: number;
  /** イシューのタイトル。PRのタイトルにする。 */
  readonly issueTitle: string;
  /** 取得と push の宛先。トークンは、gitの実行時にだけ渡す。 */
  readonly source: RepoSource;
  /** verify の結果。PRの本文に載せる。記録がなければ null。 */
  readonly verify: PublishVerifySummary | null;
}

function describeHits(hits: readonly PathHit[]): string {
  const shown = hits.slice(0, 5).map((hit) => `${hit.path}(${hit.pattern})`);
  const rest = hits.length - shown.length;
  return `${shown.join("、")}${rest > 0 ? ` ほか${rest}件` : ""}`;
}

/**
 * ワーカーのコミットを確かめ、push してPRを作る(すでにあれば更新する)。
 *
 * 1. 保存済みの `factory.yml` を読む(作業場所のファイルは使わない)。
 * 2. ミラーを最新にし、作業場所のcloneから作業用のブランチを取り込む。
 * 3. ミラーで既定ブランチとの差分を調べ、`paths.forbidden` と `paths.protected` に照らす。
 * 4. 検査を通ったら、ミラーから push し、PRを作る。同じブランチのオープンなPRがあれば、
 *    作らずに更新する。
 *
 * 検査で止まった場合(コミットなし、差分が空、禁止や保護対象のパス)は、例外ではなく結果として返す。
 * そのとき、push もPRの作成もしない。例外になるのは、検査そのものを行えない場合
 * (`factory.yml` が未取得または不正、パターンを読めない、作業場所がない、gitやGitHubの失敗)である。
 *
 * やり直して安全である。DBには書かない。`main` へのマージは行わない。
 */
export async function publish(
  deps: PublishDeps,
  input: PublishInput,
): Promise<PublishResult> {
  const { git, write } = deps;
  const { repo, issue } = input;
  const factoryYml = readStoredFactoryYml(deps.db, repo);
  // パターンを読めない場合は、gitを実行する前に失敗させる。
  checkPaths([], factoryYml.paths);
  const paths = workspacePaths(deps.dirs, repo, issue);
  const { branch, mirrorDir } = paths;

  const baseBranch = await updateMirror(git, mirrorDir, input.source);
  const imported = await importCommits(git, paths);

  const stopped = (
    status: Exclude<PublishStatus, "published" | "dry_run">,
    summary: string,
    details: Partial<PublishResult> = {},
  ): PublishResult => {
    const result: PublishResult = {
      status,
      outcome: "failed",
      awaitingApproval: status === "needs_approval",
      summary,
      branch,
      baseBranch,
      headCommit: imported,
      changedPaths: [],
      forbidden: [],
      protected: [],
      prNumber: null,
      prUrl: null,
      prCreated: false,
      ...details,
    };
    write.logger.warn("publish.stopped", {
      repo,
      issue,
      status,
      branch,
      head: result.headCommit,
      forbidden: result.forbidden,
      protected: result.protected,
    });
    return result;
  };

  if (imported === null) {
    return stopped(
      "no_commits",
      `作業場所にブランチ ${branch} がありません。コミットがないので、PRを作りません`,
    );
  }
  const changes = await inspectChanges(git, {
    mirrorDir,
    branch,
    defaultBranch: baseBranch,
  });
  if (changes.commitCount === 0) {
    return stopped(
      "no_commits",
      `ブランチ ${branch} に、${baseBranch} にないコミットがありません。PRを作りません`,
    );
  }
  if (changes.paths.length === 0) {
    return stopped(
      "empty_diff",
      `ブランチ ${branch} と ${baseBranch} の差分が空です。PRを作りません`,
    );
  }

  const check = checkPaths(changes.paths, factoryYml.paths);
  const checked = {
    changedPaths: changes.paths,
    forbidden: check.forbidden,
    protected: check.protected,
  };
  if (check.forbidden.length > 0) {
    return stopped(
      "forbidden",
      `変更してはいけないパス(paths.forbidden)に触れています。push していません: ${describeHits(check.forbidden)}`,
      checked,
    );
  }
  if (check.protected.length > 0) {
    return stopped(
      "needs_approval",
      `保護対象のパス(paths.protected)に触れています。人間の承認待ちで、push していません: ${describeHits(check.protected)}`,
      checked,
    );
  }

  const pushed = await pushBranch(write, {
    git,
    mirrorDir,
    repo,
    url: input.source.url,
    ...(input.source.token === undefined ? {} : { token: input.source.token }),
    branch,
  });
  const content = {
    title: buildPrTitle(issue, input.issueTitle),
    body: buildPrBody({
      issue,
      verify: input.verify,
      unverified: factoryYml.verify.unverified,
    }),
  };
  const existing = await write.api.findOpenPullRequest(repo, branch);
  let pr = existing;
  let prCreated = false;
  if (existing === null) {
    pr = await createPullRequest(write, repo, {
      head: branch,
      base: baseBranch,
      ...content,
    });
    prCreated = pr !== null;
  } else {
    await updatePullRequest(write, repo, existing.number, content);
  }

  const published = pushed && pr !== null;
  const result: PublishResult = {
    status: published ? "published" : "dry_run",
    outcome: "done",
    awaitingApproval: false,
    summary: published
      ? `ブランチ ${branch} を push し、PR #${pr?.number} を${prCreated ? "作りました" : "更新しました"}`
      : `検査は通りましたが、dry_run なので、push もPRの${existing === null ? "作成" : "更新"}もしていません`,
    branch,
    baseBranch,
    headCommit: changes.headCommit,
    ...checked,
    prNumber: pr?.number ?? null,
    prUrl: pr?.url ?? null,
    prCreated,
  };
  write.logger.info("publish.finished", {
    repo,
    issue,
    status: result.status,
    branch,
    head: result.headCommit,
    pr: result.prNumber,
    pr_created: prCreated,
    changed_paths: changes.paths.length,
  });
  return result;
}
