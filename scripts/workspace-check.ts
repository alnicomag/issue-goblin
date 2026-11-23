/**
 * 作業場所の準備と後片付けの確認。事務局のコンテナの中で実行する。
 *
 * 事務局のイメージに入っているgitで、設定どおりの置き場所(`repos_dir`、`work_dir`)に対して
 * prepare と cleanup が通ることを確かめ、項目ごとに合否を出す。1つでも不合格なら、
 * 終了コード1で終わる。取得元は、その場で作る仮のリポジトリで、ネットワークには出ない。
 *
 * 置き場所にミラーと作業場所を作るので、稼働中の環境ではなく、
 * scripts/check-isolation.sh が立てる確認用の環境で実行すること。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/office/config.ts";
import { createGit } from "../src/office/git.ts";
import { cleanupWorkspace, prepareWorkspace } from "../src/office/workspace.ts";

/** 事務局のコードが使う機能(`GIT_CONFIG_GLOBAL`、`GIT_CONFIG_COUNT`)に要る、gitの版。 */
const MIN_GIT_VERSION = [2, 32] as const;
/** 確認に使うイシュー番号。隔離の確認が使う番号と重ならないようにする。 */
const ISSUE = 900;

let failures = 0;
function report(ok: boolean, item: string, detail = ""): void {
  if (!ok) failures += 1;
  const suffix = detail === "" ? "" : `: ${detail}`;
  console.log(`${ok ? "OK" : "NG"}  ${item}${ok ? "" : suffix}`);
}

/** 守りを付けない素のgit。仮のリポジトリの用意と、結果の確認に使う。 */
function plainGit(cwd: string, ...args: string[]): string {
  return rawGit(
    cwd,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    ...args,
  );
}

/** 作者を渡さず、推測もさせないgit。ユーザーとシステムのgit設定は読まない。 */
function unconfiguredGit(cwd: string, ...args: string[]): string {
  return rawGit(cwd, "-c", "user.useConfigOnly=true", ...args);
}

function rawGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const [first] = config.repos;
  if (first === undefined) {
    throw new Error("確認には、設定にリポジトリが1つ要ります");
  }
  const dirs = { reposDir: config.repos_dir, workDir: config.work_dir };
  const git = createGit();

  console.log("# 事務局のコンテナのgit");
  report(
    process.getuid?.() !== 0,
    "事務局は、rootではないユーザーで動いている",
    os.userInfo().username,
  );
  const versionText = (await git.run(["--version"])).trim();
  const match = /(\d+)\.(\d+)/.exec(versionText);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  report(
    major > MIN_GIT_VERSION[0] ||
      (major === MIN_GIT_VERSION[0] && minor >= MIN_GIT_VERSION[1]),
    `gitが ${MIN_GIT_VERSION.join(".")} 以降である(${versionText})`,
  );

  console.log("\n# 作業場所の準備と後片付け");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-check-"));
  const input = {
    dirs,
    repo: first.repo,
    issue: ISSUE,
    author: config.commit_author,
  };
  try {
    const source = path.join(tmp, "source");
    fs.mkdirSync(source);
    plainGit(source, "init", "--quiet", "--initial-branch=main");
    fs.writeFileSync(path.join(source, "README.txt"), "example\n");
    plainGit(source, "add", "--", "README.txt");
    plainGit(source, "commit", "--quiet", "-m", "example");
    const tip = plainGit(source, "rev-parse", "HEAD");

    const prepared = await prepareWorkspace(
      { git },
      { ...input, source: { url: source } },
    );
    report(
      prepared.created &&
        prepared.repoDir.startsWith(`${config.work_dir}${path.sep}`) &&
        prepared.mirrorDir.startsWith(`${config.repos_dir}${path.sep}`),
      "prepare で、設定の置き場所にミラーと作業場所ができる",
      `${prepared.mirrorDir} / ${prepared.repoDir}`,
    );
    report(
      plainGit(prepared.repoDir, "symbolic-ref", "HEAD") ===
        `refs/heads/${prepared.branch}` &&
        plainGit(prepared.repoDir, "rev-parse", "HEAD") === tip,
      `ブランチ ${prepared.branch} が、取得元の既定ブランチの最新を指す`,
    );
    report(
      fs.existsSync(path.join(prepared.repoDir, "README.txt")) &&
        fs.statSync(prepared.homeDir).isDirectory(),
      "作業場所に、製品のファイルとワーカーのHOMEがある",
    );
    report(
      plainGit(prepared.repoDir, "remote") === "",
      "作業場所のcloneに、リモートがない",
    );

    const again = await prepareWorkspace(
      { git },
      { ...input, source: { url: source } },
    );
    report(
      !again.created && again.repoDir === prepared.repoDir,
      "prepare をやり直すと、すでにある作業場所を使う",
    );

    let committed: string;
    try {
      fs.writeFileSync(path.join(prepared.repoDir, "work.txt"), "work\n");
      unconfiguredGit(prepared.repoDir, "add", "--", "work.txt");
      unconfiguredGit(prepared.repoDir, "commit", "--quiet", "-m", "work");
      committed = unconfiguredGit(
        prepared.repoDir,
        "log",
        "-1",
        "--format=%an <%ae>",
      );
    } catch (error) {
      committed = String(error);
    }
    const expected = `${config.commit_author.name} <${config.commit_author.email}>`;
    report(
      committed === expected,
      `作業場所で、git設定を足さずにコミットでき、作者が設定の値(${expected})になる`,
      committed,
    );

    cleanupWorkspace(input);
    report(
      !fs.existsSync(prepared.issueDir) && fs.existsSync(prepared.mirrorDir),
      "cleanup で作業場所が消え、ミラーは残る",
    );
    cleanupWorkspace(input);
    report(true, "cleanup は、すでになくても失敗しない");

    // 確認用に作ったミラーを消す。
    fs.rmSync(prepared.mirrorDir, { recursive: true, force: true });
  } finally {
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
