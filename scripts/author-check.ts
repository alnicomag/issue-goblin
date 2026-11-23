/**
 * コミットの作者の確認。事務局のコンテナの中で実行する。
 *
 * 設定の検証を通る作者の例それぞれについて、ワーカーのイメージのgitが、その作者を
 * そのままコミットに書くことを確かめ、項目ごとに合否を出す。1つでも不合格なら、
 * 終了コード1で終わる。
 *
 * gitは、コミットに書くときに、名前とメールアドレスの先頭と末尾から一部の文字を落とす。
 * どの文字を落とすかはgitの版で違い、コミットを作るのはワーカーのイメージのgitである。
 * 設定の検証が通す値を、そのgitが変えてしまうと、正しいコミットも publish の作者の検査で止まる。
 * 自動テストは、テストを実行する環境のgitを使うので、この食い違いには気づけない。
 *
 * 例ごとに、本番と同じ経路を通す。
 *
 * 1. 例を、設定の検証に通す。
 * 2. 事務局のgitで、作業場所を作る(作者が、cloneのgit設定に書かれる)。
 * 3. 起動係を通して、ワーカーのイメージのコンテナで、コミットを1つ作る。
 * 4. 事務局がコミットをミラーに取り込み、作者とコミッターを、publish と同じ関数で照合する。
 *
 * 取得元は、その場で作る仮のリポジトリで、ネットワークには出ない。
 * 置き場所にミラーと作業場所を作るので、稼働中の環境ではなく、
 * scripts/check-isolation.sh が立てる確認用の環境で実行すること。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLauncherClient } from "../src/launcher/client.ts";
import { checkCommitAuthors, type Identity } from "../src/office/authors.ts";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  parseConfig,
} from "../src/office/config.ts";
import { createGit } from "../src/office/git.ts";
import {
  importCommits,
  inspectChanges,
  listCommitIdentities,
} from "../src/office/publish.ts";
import { buildVerifyArgv } from "../src/office/verify.ts";
import {
  cleanupWorkspace,
  prepareWorkspace,
  workspacePaths,
} from "../src/office/workspace.ts";
import { ACCEPTED_COMMIT_AUTHORS } from "./commit-author-examples.ts";

/** 確認に使うイシュー番号の始まり。例ごとに1つずつ使う。ほかの確認が使う番号と重ならないようにする。 */
const FIRST_ISSUE = 910;
/** 取得元の既定ブランチ。 */
const DEFAULT_BRANCH = "main";
/** ワーカーのコンテナで実行する。作者は渡さず、作業場所のgit設定で決めさせる。 */
const COMMIT_COMMAND = "git commit --quiet --allow-empty -m 'author check'";

let failures = 0;
function report(ok: boolean, item: string, detail = ""): void {
  if (!ok) failures += 1;
  const suffix = detail === "" ? "" : `: ${detail}`;
  console.log(`${ok ? "OK" : "NG"}  ${item}${ok ? "" : suffix}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`環境変数 ${name} がありません`);
  }
  return value;
}

/** 守りを付けない素のgit。仮のリポジトリの用意に使う。 */
function plainGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}

/** 例を、ファクトリー側の設定の検証に通す。通らなければ例外になる。 */
function validatedAuthor(example: Identity): Identity {
  return parseConfig(
    [
      "db_path: /data/factory.db",
      "repos_dir: /data/repos",
      "work_dir: /work",
      "repos:",
      "  - repo: owner/name",
      "    token_env: GITHUB_TOKEN_EXAMPLE",
      // JSONは、YAMLとしても読める。
      `commit_author: ${JSON.stringify(example)}`,
      "",
    ].join("\n"),
    "作者の例",
  ).commit_author;
}

/** 見分けられるように、空白や制御文字もそのまま分かる形にする。 */
function show(identity: Identity): string {
  return `${JSON.stringify(identity.name)} <${JSON.stringify(identity.email)}>`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const [first] = config.repos;
  if (first === undefined) {
    throw new Error("確認には、設定にリポジトリが1つ要ります");
  }
  const repo = first.repo;
  const dirs = { reposDir: config.repos_dir, workDir: config.work_dir };
  const git = createGit();
  const launcher = createLauncherClient({
    socketPath: requireEnv("LAUNCHER_SOCKET"),
  });
  const runInWorker = (issue: number, command: string) =>
    launcher.run({
      repo,
      issue,
      argv: buildVerifyArgv(command),
      claude_token: false,
      timeout_sec: 60,
    });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "author-check-"));
  const issues = ACCEPTED_COMMIT_AUTHORS.map((_, index) => FIRST_ISSUE + index);
  const { mirrorDir } = workspacePaths(dirs, repo, FIRST_ISSUE);
  try {
    const source = path.join(tmp, "source");
    fs.mkdirSync(source);
    plainGit(source, "init", "--quiet", `--initial-branch=${DEFAULT_BRANCH}`);
    fs.writeFileSync(path.join(source, "README.txt"), "example\n");
    plainGit(source, "add", "--", "README.txt");
    plainGit(source, "commit", "--quiet", "-m", "example");

    console.log("# ワーカーのイメージのgit");
    for (const [index, example] of ACCEPTED_COMMIT_AUTHORS.entries()) {
      const issue = FIRST_ISSUE + index;
      const item = `設定の作者 ${show(example)} が、そのままコミットに書かれる`;
      try {
        const author = validatedAuthor(example);
        const paths = await prepareWorkspace(
          { git },
          { dirs, repo, issue, source: { url: source }, author },
        );
        if (index === 0) {
          const version = await runInWorker(issue, "git --version");
          console.log(`    (${version.stdout.trim()})`);
        }
        const run = await runInWorker(issue, COMMIT_COMMAND);
        if (run.exit_code !== 0) {
          report(
            false,
            item,
            `ワーカーのコンテナでコミットできません(終了コード ${String(run.exit_code)}): ${run.stderr.trim()}`,
          );
          continue;
        }
        await importCommits(git, paths);
        const range = {
          mirrorDir: paths.mirrorDir,
          branch: paths.branch,
          defaultBranch: DEFAULT_BRANCH,
        };
        const changes = await inspectChanges(git, range);
        const commits = await listCommitIdentities(git, {
          ...range,
          expectedCount: changes.commitCount,
        });
        const [commit] = commits;
        // 前のコミットを見て合格にしないように、今回のコミットがちょうど1つあることを確かめる。
        if (commit === undefined || commits.length !== 1) {
          report(
            false,
            item,
            `ワーカーが作ったコミットが1つではありません(${commits.length}件)`,
          );
          continue;
        }
        report(
          checkCommitAuthors(commits, author).length === 0,
          item,
          `設定の値は ${show(author)}、コミットに書かれた作者は ${show(commit.author)}、コミッターは ${show(commit.committer)}`,
        );
      } catch (error) {
        report(
          false,
          item,
          error instanceof Error ? error.message : `${error}`,
        );
      }
    }
  } finally {
    for (const issue of issues) cleanupWorkspace({ dirs, repo, issue });
    // 確認用に作ったミラーを消す。
    fs.rmSync(mirrorDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? "\nすべて合格しました"
      : `\n不合格が ${failures} 件あります`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
