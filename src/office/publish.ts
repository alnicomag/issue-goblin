/**
 * publish: ワーカーのコミットを確かめ、push してPRにする。
 *
 * ワーカーの申告には頼らない。事務局が、作業場所のcloneから事務局専用のミラーにコミットを取り込み、
 * ミラーで既定ブランチとの差分と、コミットの作者を調べる。push はミラーから行う。
 *
 * 作業場所はワーカーが書き換えられる。そこにあるフックやgit設定で、事務局の権限のまま
 * コマンドが動かないように、gitは `git.ts` を通して実行する。差分の検査も、作業場所ではなく
 * ミラーで行う。
 */
import fs from "node:fs";
import {
  COMMIT_IDENTITY_FORMAT,
  type CommitIdentity,
  checkCommitAuthors,
  type Identity,
  parseCommitIdentities,
} from "./authors.ts";
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
import { maskSecrets } from "./step-log.ts";
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

/**
 * ミラーで、既定ブランチになく、作業用のブランチにあるコミットの、作者とコミッターを読む。
 * 読むだけで、何も変えない。
 *
 * 作業場所のgit設定ではなく、取り込んだコミットそのものを読む。取得元にもとからあるコミット
 * (既定ブランチから届くもの)は含めない。`expectedCount` は、同じ範囲を数えたコミットの数で、
 * 読めた数と合わなければ失敗させる。作者の欄に区切りの文字を仕込んで、コミットを隠したり
 * 増やしたりした場合に、気づけるようにするためである。
 */
export async function listCommitIdentities(
  git: Git,
  input: {
    mirrorDir: string;
    branch: string;
    defaultBranch: string;
    expectedCount: number;
  },
): Promise<CommitIdentity[]> {
  const output = await git.run(
    [
      "log",
      "-z",
      `--format=${COMMIT_IDENTITY_FORMAT}`,
      `refs/remotes/origin/${input.defaultBranch}..refs/heads/${input.branch}`,
      "--",
    ],
    { cwd: input.mirrorDir },
  );
  const commits = parseCommitIdentities(output);
  if (commits.length !== input.expectedCount) {
    throw new Error(
      `コミットの作者を読めません: ブランチ ${input.branch} のコミットは${input.expectedCount}件ですが、読めたのは${commits.length}件です`,
    );
  }
  return commits;
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

/** PRの本文に載せる要約1つの、文字数の上限。越えた分は、省略を明記して切る。 */
export const SUMMARY_LIMIT = 20_000;

/** 要約を切り詰めたときに、末尾に足す断り書き。 */
export const SUMMARY_TRUNCATED_NOTE =
  "(長いので、ここから先を省略しました。全文は事務局の記録にあります)";

/** 要約の記録がないときに、節に書く文。 */
export const SUMMARY_MISSING_NOTE = "要約の記録がありません。";

/** ワーカーの節の前に置く断り書き。ここから本文の末尾までが、ワーカーの申告である。 */
export const WORKER_SECTIONS_NOTE =
  "ここから下は、ワーカー(Claude)の申告です。事務局は、中身を確かめていません。";

/**
 * 要約の中の記号を置き換える、全角の文字。
 * 見た目で置き換えたと分かり、GitHubはこれらを記号として扱わない。
 */
const FULLWIDTH = {
  lessThan: "\uFF1C",
  hash: "\uFF03",
  colon: "\uFF1A",
  at: "\uFF20",
} as const;

/** 閉じていないコードブロックがあれば、閉じるための行を返す。なければ null。 */
function unclosedFence(text: string): string | null {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? "";
    const rest = match[2] ?? "";
    const char = marker.charAt(0);
    if (open === null) {
      // バッククォートで始めるときは、同じ行にバッククォートを書けない。
      if (char === "`" && rest.includes("`")) continue;
      open = { char, length: marker.length };
    } else if (
      char === open.char &&
      marker.length >= open.length &&
      rest.trim() === ""
    ) {
      open = null;
    }
  }
  return open === null ? null : open.char.repeat(open.length);
}

/**
 * ワーカーの要約を、PRの本文に載せられる形にする純粋関数。
 *
 * 要約はワーカー(Claude)の出力で、製品のイシューやリポジトリの文章の影響を受ける。
 * 中身は解釈せず、本文のほかの部分やGitHubの動きに作用する書き方だけを、機械的に崩す。
 * コードの中かどうかは見分けない(見分けを誤ると、すり抜けになるため)。
 *
 * - トークンに見える文字列を伏せる(ログと同じ伏せ方)。
 * - HTMLコメントの始まり(`<!--`)を、全角の `<` に変える。目印や、閉じないコメントを作らせない。
 * - イシューを閉じる書き方(`Closes #1` など)の `#` を、全角に変える。URLで書いたものは `:` を全角に変える。
 * - メンション(`@name`)の `@` を、全角に変える。
 * - 上限を越えた分を、行の区切りで切り、省略したと書く。
 * - 閉じていないコードブロックを閉じる。
 */
export function sanitizeSummary(summary: string): string {
  let text = maskSecrets(summary)
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/<!--/g, `${FULLWIDTH.lessThan}!--`)
    .replace(
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)((?:[\w.-]+\/[\w.-]+)?)#(?=\d)/gi,
      `$1$2$3${FULLWIDTH.hash}`,
    )
    .replace(
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)(https?):(?=\/\/)/gi,
      `$1$2$3${FULLWIDTH.colon}`,
    )
    .replace(/(?<![A-Za-z0-9_])@(?=[A-Za-z0-9])/g, FULLWIDTH.at);

  let truncated = false;
  if (text.length > SUMMARY_LIMIT) {
    truncated = true;
    text = text.slice(0, SUMMARY_LIMIT);
    // 文字の途中(サロゲートペアの前半)で切らない。
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const lineEnd = text.lastIndexOf("\n");
    if (lineEnd > 0) text = text.slice(0, lineEnd);
    text = text.trimEnd();
  }
  const fence = unclosedFence(text);
  if (fence !== null) text = `${text}\n${fence}`;
  if (truncated) text = `${text}\n\n${SUMMARY_TRUNCATED_NOTE}`;
  return text;
}

/** ワーカーの要約の節。要約がなければ、ないと書く。 */
function summarySection(heading: string, summary: string | null): string[] {
  const text = summary === null ? "" : sanitizeSummary(summary);
  return ["", `## ${heading}`, "", text === "" ? SUMMARY_MISSING_NOTE : text];
}

/**
 * PRの本文を組み立てる純粋関数。
 *
 * 前半は、事務局が確かめたことである。対応イシュー(マージでイシューが閉じる書き方)、検証結果、
 * ワーカーの環境では確かめられない範囲(`verify.unverified`)を書く。検査コマンドの出力は載せない。
 *
 * 後半は、ワーカーの申告である。`implement` と `review` の要約を、申告と分かる見出しで載せる。
 * 要約の中身が本文を崩しても、前半に及ばないように、後ろに置く。末尾に目印を付ける。
 */
export function buildPrBody(input: {
  issue: number;
  verify: PublishVerifySummary | null;
  unverified: readonly string[];
  /** 最後の `implement` の要約。記録がなければ null。 */
  implementSummary: string | null;
  /** 最後の `review` の要約。記録がなければ null。 */
  reviewSummary: string | null;
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
  lines.push(
    "",
    "---",
    "",
    WORKER_SECTIONS_NOTE,
    ...summarySection("実装の要約(ワーカーの申告)", input.implementSummary),
    ...summarySection("レビューの結果(ワーカーの申告)", input.reviewSummary),
    "",
    FACTORY_MARKER,
    "",
  );
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
 * - `author_mismatch`: 作者かコミッターが `commit_author` と一致しないコミットがある。push していない。
 * - `empty_diff`: コミットはあるが、既定ブランチとの差分が空。
 * - `forbidden`: `paths.forbidden` に当たる変更がある。push しておらず、人間の対応待ち。
 * - `needs_approval`: `paths.protected` に当たる変更がある。push しておらず、人間の承認待ち。
 */
export type PublishStatus =
  | "published"
  | "dry_run"
  | "no_commits"
  | "author_mismatch"
  | "empty_diff"
  | "forbidden"
  | "needs_approval";

/** publish の結果。チェックポイント(`steps.output`)に残せる形にしてある。 */
export interface PublishResult {
  readonly status: PublishStatus;
  /**
   * ステップの結果。`published` と `dry_run` は `done`。
   * `forbidden` と `needs_approval` は `held`(人間の対応待ち。再試行しない)。ほかは `failed`。
   */
  readonly outcome: "done" | "failed" | "held";
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
  /**
   * 作者かコミッターが `commit_author` と一致しなかったコミット(`author_mismatch` のときだけ入る)。
   * コミットのハッシュと、そのコミットに書かれていた作者とコミッターを残す。
   */
  readonly authorMismatches: readonly CommitIdentity[];
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
  /**
   * ワーカーのコミットの作者。ファクトリー側の設定(`commit_author`)から渡す。
   * 取り込んだコミットの作者とコミッターが、これと一致しなければ push しない。
   */
  readonly author: Identity;
  /** verify の結果。PRの本文に載せる。記録がなければ null。 */
  readonly verify: PublishVerifySummary | null;
  /** 最後の `implement` の要約。PRの本文に、ワーカーの申告として載せる。記録がなければ null。 */
  readonly implementSummary: string | null;
  /** 最後の `review` の要約。PRの本文に、ワーカーの申告として載せる。記録がなければ null。 */
  readonly reviewSummary: string | null;
}

function describeHits(hits: readonly PathHit[]): string {
  const shown = hits.slice(0, 5).map((hit) => `${hit.path}(${hit.pattern})`);
  const rest = hits.length - shown.length;
  return `${shown.join("、")}${rest > 0 ? ` ほか${rest}件` : ""}`;
}

function describeIdentity(identity: Identity): string {
  return oneLine(`${identity.name} <${identity.email}>`);
}

function describeMismatches(mismatches: readonly CommitIdentity[]): string {
  const shown = mismatches
    .slice(0, 5)
    .map(
      (entry) =>
        `${entry.commit.slice(0, 12)}(作者 ${describeIdentity(entry.author)}、コミッター ${describeIdentity(entry.committer)})`,
    );
  const rest = mismatches.length - shown.length;
  return `${shown.join("、")}${rest > 0 ? ` ほか${rest}件` : ""}`;
}

/**
 * ワーカーのコミットを確かめ、push してPRを作る(すでにあれば更新する)。
 *
 * 1. 保存済みの `factory.yml` を読む(作業場所のファイルは使わない)。
 * 2. ミラーを最新にし、作業場所のcloneから作業用のブランチを取り込む。
 * 3. ミラーで、既定ブランチにないコミットの作者とコミッターが、`author` と一致するかを確かめる。
 * 4. ミラーで既定ブランチとの差分を調べ、`paths.forbidden` と `paths.protected` に照らす。
 * 5. 検査を通ったら、ミラーから push し、PRを作る。同じブランチのオープンなPRがあれば、
 *    作らずに更新する。
 *
 * 検査で止まった場合(コミットなし、作者の不一致、差分が空、禁止や保護対象のパス)は、例外ではなく結果として返す。
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
      outcome:
        status === "forbidden" || status === "needs_approval"
          ? "held"
          : "failed",
      awaitingApproval: status === "needs_approval",
      summary,
      branch,
      baseBranch,
      headCommit: imported,
      changedPaths: [],
      forbidden: [],
      protected: [],
      authorMismatches: [],
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
      author_mismatches: result.authorMismatches,
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
  const mismatches = checkCommitAuthors(
    await listCommitIdentities(git, {
      mirrorDir,
      branch,
      defaultBranch: baseBranch,
      expectedCount: changes.commitCount,
    }),
    input.author,
  );
  if (mismatches.length > 0) {
    return stopped(
      "author_mismatch",
      `作者かコミッターが、設定(commit_author)の ${describeIdentity(input.author)} と一致しないコミットがあります。push していません: ${describeMismatches(mismatches)}`,
      { authorMismatches: mismatches },
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
      implementSummary: input.implementSummary,
      reviewSummary: input.reviewSummary,
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
    authorMismatches: [],
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
