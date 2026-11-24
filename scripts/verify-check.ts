/**
 * verify の確認。事務局のコンテナの中で実行する。
 *
 * 起動係を通して、実際のコンテナで仮の検査コマンドを実行し、合否、時間切れ、
 * コンテナに渡る環境変数、ログを調べて、項目ごとに合否を出す。1つでも不合格なら、
 * 終了コード1で終わる。時間切れの後にコンテナが残っていないことは、
 * 呼び出し元(scripts/check-isolation.sh)が確かめる。
 *
 * 作業場所に確認用のディレクトリを作るので、稼働中の環境ではなく、
 * scripts/check-isolation.sh が立てる確認用の環境で実行すること。
 */
import fs from "node:fs";
import { createLauncherClient } from "../src/launcher/client.ts";
import { systemClock } from "../src/office/clock.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/office/config.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { createGit } from "../src/office/git.ts";
import { FactoryYmlSchema } from "../src/office/product.ts";
import { runVerify } from "../src/office/verify.ts";
import {
  branchFor,
  cleanupWorkspace,
  workspacePaths,
} from "../src/office/workspace.ts";

/** 確認に使うイシュー番号。ほかの確認が使う番号と重ならないようにする。 */
const ISSUE = 901;
const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** トークンに見える仮の文字列。実際のトークンではない。 */
const FAKE_TOKEN = `sk-ant-${"oat01"}-verify-check-0000`;

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

function setCommands(
  db: Db,
  repo: string,
  commands: { setup: string; test: string; lint: string },
): void {
  const factoryYml = FactoryYmlSchema.parse({
    version: 1,
    level: "A",
    commands,
    issues: { allowed_authors: [] },
  });
  db.prepare(
    `INSERT INTO repos (repo, factory_yml, factory_yml_sha) VALUES (?, ?, 'check')
     ON CONFLICT (repo) DO UPDATE SET factory_yml = excluded.factory_yml`,
  ).run(repo, JSON.stringify(factoryYml));
}

/** ログから、コマンド1つの標準出力を取り出す。 */
function stdoutOf(log: string, name: string): string {
  const start = log.indexOf(`--- ${name} stdout ---\n`);
  const end = log.indexOf(`\n--- ${name} stderr ---`);
  if (start === -1 || end === -1) {
    throw new Error(`ログに ${name} の出力がありません`);
  }
  return log.slice(start + `--- ${name} stdout ---\n`.length, end);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const [first] = config.repos;
  if (first === undefined) {
    throw new Error("確認には、設定にリポジトリが1つ要ります");
  }
  const repo = first.repo;
  const dirs = { reposDir: config.repos_dir, workDir: config.work_dir };
  const paths = workspacePaths(dirs, repo, ISSUE);
  // DBは、この確認の中だけのものを使う(事務局のDBファイルには触れない)。
  const db = openDb(":memory:");
  migrate(db, { clock: systemClock });
  const deps = {
    db,
    launcher: createLauncherClient({
      socketPath: requireEnv("LAUNCHER_SOCKET"),
    }),
    dirs,
    logsDir: config.logs_dir,
  };
  const input = { repo, issue: ISSUE, timeoutSec: 120 };

  // 確認用のcloneを作る。ワーカーが触る前なので、事務局の側でgitを実行してよい(prepare と同じ)。
  // verify は、コミットされていない内容が残っていると止まるので、使うファイルはコミットしておく。
  // 作業用のブランチ以外が取り出されていても止まるので、ブランチは prepare と同じ名前にする。
  const branch = branchFor(ISSUE);
  const git = createGit();
  cleanupWorkspace({ dirs, repo, issue: ISSUE });
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.homeDir, { recursive: true });
  await git.run(["init", "--quiet", `--initial-branch=${branch}`, "--", "."], {
    cwd: paths.repoDir,
  });
  fs.writeFileSync(`${paths.repoDir}/leak.txt`, `${FAKE_TOKEN}\n`);
  // setup が書くファイルは、依存の置き場所と同じく、無視対象にする。
  fs.writeFileSync(`${paths.repoDir}/.gitignore`, "prepared.txt\n");
  await git.run(["add", "--", "leak.txt", ".gitignore"], {
    cwd: paths.repoDir,
  });
  await git.run(
    [
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "check",
    ],
    { cwd: paths.repoDir },
  );
  const logs: string[] = [];

  try {
    // 前提: 事務局はGitHubのトークンを持っている(コンテナに渡っていないことを確かめる相手)。
    const officeSecrets = Object.entries(process.env).filter(([name]) =>
      name.startsWith("GITHUB_TOKEN"),
    );
    report(
      officeSecrets.length > 0,
      "前提: 事務局の環境変数には、GitHubのトークンがある",
    );

    console.log("\n# 合格する場合");
    setCommands(db, repo, {
      setup: "echo prepared > prepared.txt",
      test: "cat prepared.txt && env",
      lint: `test -z "\${${CLAUDE_TOKEN_ENV}:-}" && cat leak.txt`,
    });
    const passed = await runVerify(deps, input);
    logs.push(passed.logPath);
    report(
      passed.outcome === "done" && passed.passed,
      "すべてのコマンドが終了コード0なら、合格になる",
      passed.summary,
    );
    report(
      passed.commands.every(
        (command) => command.exitCode === 0 && (command.durationMs ?? -1) >= 0,
      ),
      "コマンドごとに、終了コードと所要時間が記録される",
    );
    const passedLog = fs.readFileSync(passed.logPath, "utf8");
    const testOutput = stdoutOf(passedLog, "test");
    report(
      testOutput.startsWith("prepared\n"),
      "コマンドは作業場所で順に実行される(setup の結果が test から見える)",
    );
    const names = testOutput
      .split("\n")
      .slice(1)
      .map((line) => line.split("=")[0] ?? "")
      .filter((name) => name !== "");
    const officeOnly = Object.keys(process.env).filter(
      (name) =>
        !["PATH", "HOME", "HOSTNAME", "PWD"].includes(name) &&
        !name.startsWith("NODE_") &&
        !name.startsWith("YARN_"),
    );
    const inherited = names.filter((name) => officeOnly.includes(name));
    report(
      names.length > 0 && inherited.length === 0,
      "コンテナの環境変数に、事務局の環境変数が1つも引き継がれていない",
      inherited.join(", "),
    );
    report(
      officeSecrets.every(
        ([, value]) => value === undefined || !passedLog.includes(value),
      ) && !names.some((name) => name.startsWith("GITHUB")),
      "コンテナの環境変数に、GitHubのトークンがない",
    );
    report(
      !names.includes(CLAUDE_TOKEN_ENV) && passed.commands[2]?.exitCode === 0,
      "verifyのコンテナに、Claudeのトークンが渡っていない",
    );
    report(
      passedLog.includes("sk-ant-***") && !passedLog.includes(FAKE_TOKEN),
      "出力にトークンに見える文字列があっても、ログでは伏せられる",
    );

    console.log("\n# 不合格になる場合");
    setCommands(db, repo, {
      setup: "true",
      test: "echo broken; exit 3",
      lint: "true",
    });
    const failed = await runVerify(deps, input);
    logs.push(failed.logPath);
    report(
      failed.outcome === "rework" &&
        !failed.passed &&
        failed.failedCommands.join() === "test" &&
        failed.commands[1]?.exitCode === 3 &&
        failed.commands[1]?.outputTail === "broken",
      "0以外で終わったコマンドがあると不合格になり、どのコマンドかが結果に含まれる",
      JSON.stringify(failed.commands),
    );
    report(
      fs.existsSync(failed.logPath) &&
        fs.readFileSync(failed.logPath, "utf8").includes("broken"),
      "不合格の結果に、ログの場所が含まれ、そこに出力がある",
      failed.logPath,
    );
    report(
      !failed.logPath.startsWith(config.work_dir),
      "ログは、作業場所の外にある",
      failed.logPath,
    );

    console.log("\n# コミットされていない内容が残っている場合");
    setCommands(db, repo, {
      setup: "echo ran > ran-setup.txt",
      test: "true",
      lint: "true",
    });
    fs.writeFileSync(`${paths.repoDir}/untracked.txt`, "left\n");
    fs.appendFileSync(`${paths.repoDir}/leak.txt`, "changed\n");
    const dirty = await runVerify(deps, input);
    logs.push(dirty.logPath);
    report(
      dirty.outcome === "rework" &&
        dirty.commands.every((command) => command.status === "skipped") &&
        !fs.existsSync(`${paths.repoDir}/ran-setup.txt`),
      "コミットされていない内容が残っていると、コマンドを1つも実行せずに差し戻す",
      JSON.stringify(dirty.commands),
    );
    report(
      [...dirty.uncommittedPaths].sort().join() === "leak.txt,untracked.txt",
      "残っているパス(変更と、追跡していないファイル)が結果に含まれ、無視対象は含まれない",
      JSON.stringify(dirty.uncommittedPaths),
    );
    fs.rmSync(`${paths.repoDir}/untracked.txt`);
    fs.writeFileSync(`${paths.repoDir}/leak.txt`, `${FAKE_TOKEN}\n`);

    console.log("\n# 作業用のブランチ以外が取り出されている場合");
    // 取り出されているものだけを変える。gitを実行せずに、HEADを書き換える。
    const headFile = `${paths.repoDir}/.git/HEAD`;
    const originalHead = fs.readFileSync(headFile, "utf8");
    const tip = fs
      .readFileSync(`${paths.repoDir}/.git/refs/heads/${branch}`, "utf8")
      .trim();
    fs.writeFileSync(`${paths.repoDir}/.git/refs/heads/other`, `${tip}\n`);
    for (const [name, head, checkedOut] of [
      ["別のブランチ", "ref: refs/heads/other", "other"],
      ["ブランチなしの取り出し", tip, "HEAD (no branch)"],
    ] as const) {
      fs.writeFileSync(headFile, `${head}\n`);
      const wrong = await runVerify(deps, input);
      logs.push(wrong.logPath);
      report(
        wrong.outcome === "rework" &&
          wrong.commands.every((command) => command.status === "skipped") &&
          !fs.existsSync(`${paths.repoDir}/ran-setup.txt`) &&
          wrong.wrongBranch?.checkedOut === checkedOut &&
          wrong.wrongBranch.expected === branch,
        `${name}になっていると、コマンドを1つも実行せずに差し戻す`,
        `${wrong.outcome} ${JSON.stringify(wrong.wrongBranch)} ${wrong.summary}`,
      );
    }
    fs.writeFileSync(headFile, originalHead);
    fs.rmSync(`${paths.repoDir}/.git/refs/heads/other`);

    console.log("\n# 時間切れになる場合");
    setCommands(db, repo, {
      setup: "true",
      // 子プロセスを残したまま待つ。コンテナごと止まらなければ、残り続ける。
      test: "sleep 600 & sleep 600",
      lint: "true",
    });
    const startedAt = Date.now();
    const slow = await runVerify(deps, { ...input, timeoutSec: 3 });
    const elapsedSec = (Date.now() - startedAt) / 1000;
    logs.push(slow.logPath);
    report(
      slow.outcome === "rework" &&
        slow.failedCommands.join() === "test" &&
        slow.commands[1]?.status === "timed_out",
      "時間切れのコマンドは、不合格として扱われる",
      JSON.stringify(slow.commands),
    );
    report(
      elapsedSec < 60,
      "時間の上限を過ぎると、コマンドの終了を待たずに止まる",
      `${elapsedSec.toFixed(1)}秒`,
    );
  } finally {
    cleanupWorkspace({ dirs, repo, issue: ISSUE });
    for (const log of logs) fs.rmSync(log, { force: true });
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
