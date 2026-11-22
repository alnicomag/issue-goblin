/**
 * ワーカーの呼び出しの確認。事務局のコンテナの中で実行する。
 *
 * 起動係を通してワーカーのコンテナで実際にClaudeを呼び、結果を受け取れること、
 * ターン数と時間の上限が効くことを確かめて、項目ごとに合否を出す。
 * 1つでも不合格なら、終了コード1で終わる。
 *
 * 実際のClaudeのトークンを使う(サブスクリプションの枠を少し使う)。
 * 作業場所に確認用のディレクトリを作るので、稼働中の環境ではなく、
 * scripts/check-worker.sh が立てる確認用の環境で実行すること。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROMPTS_DIR } from "../src/agents/prompts.ts";
import {
  createClaudeWorker,
  type WorkerCall,
  type WorkerInvocation,
} from "../src/agents/worker.ts";
import { createLauncherClient } from "../src/launcher/client.ts";
import { issueDirFor } from "../src/launcher/container.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/office/config.ts";

/** 確認に使うイシュー番号。ほかの確認が使う番号と重ならないようにする。 */
const ISSUE = 950;

let failures = 0;
function report(ok: boolean, item: string, detail = ""): void {
  if (!ok) failures += 1;
  const suffix = detail === "" ? "" : `: ${detail}`;
  console.log(`${ok ? "OK" : "NG"}  ${item}${ok ? "" : suffix}`);
}

function describe(result: WorkerInvocation): string {
  return `status=${result.status} summary=${JSON.stringify(result.summary)}`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const [first] = config.repos;
  if (first === undefined) {
    throw new Error("確認には、設定にリポジトリが1つ要ります");
  }
  const socketPath = process.env.LAUNCHER_SOCKET;
  if (socketPath === undefined || socketPath === "") {
    throw new Error("環境変数 LAUNCHER_SOCKET がありません");
  }

  // 作業場所を用意する。中身は、その場で決めた目印を書いたファイルが1つだけ。
  const issueDir = path.join(config.work_dir, issueDirFor(first.repo, ISSUE));
  const marker = `marker-${randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.join(issueDir, "repo"), { recursive: true });
  fs.mkdirSync(path.join(issueDir, "home"), { recursive: true });
  fs.writeFileSync(path.join(issueDir, "repo", "check-input.txt"), marker);

  const worker = createClaudeWorker({
    launcher: createLauncherClient({ socketPath }),
    promptsDir: DEFAULT_PROMPTS_DIR,
    logsDir: config.logs_dir,
  });
  const call: WorkerCall = {
    repo: first.repo,
    issue: ISSUE,
    step: "check",
    prompt: "check",
    input: "",
    timeoutSec: 300,
    maxTurns: 10,
  };
  const logKept = (result: WorkerInvocation): boolean =>
    result.logPath.startsWith(`${config.logs_dir}${path.sep}`) &&
    fs.existsSync(result.logPath);

  console.log("# 実際に1回呼び出す");
  const done = await worker.invoke(call);
  report(done.status === "done", "結果を受け取れる(done)", describe(done));
  report(
    done.summary.includes(marker),
    "ワーカーが、作業場所のファイルを読めている",
    describe(done),
  );
  report(
    done.summary.includes("push=denied"),
    "拒否設定が効いている(git push のツール呼び出しが拒否される)",
    describe(done),
  );
  report(done.sessionId !== null, "セッションIDが返る", String(done.sessionId));
  report(
    done.costUsd !== null && done.costUsd > 0,
    "金額が返る",
    String(done.costUsd),
  );
  console.log(
    `      (金額: ${String(done.costUsd)} 米ドル、ターン数: ${String(done.numTurns)})`,
  );
  report(logKept(done), "ログがファイルに残る", done.logPath);
  console.log(`      (ログ: ${done.logPath})`);
  const sessions = path.join(issueDir, "home", ".claude");
  report(
    fs.existsSync(sessions),
    "セッションが、ワーカーのHOME(作業場所の中)に残る",
    sessions,
  );

  console.log("\n# ターン数の上限");
  const turns = await worker.invoke({ ...call, step: "turns", maxTurns: 1 });
  report(
    turns.status === "failed" && turns.summary.includes("ターン数の上限"),
    "上限に達すると failed になる",
    describe(turns),
  );
  report(
    turns.sessionId !== null && turns.costUsd !== null,
    "上限に達した場合も、セッションIDと金額が返る",
  );
  report(logKept(turns), "上限に達した場合も、ログが残る", turns.logPath);

  console.log("\n# 時間の上限");
  const startedAt = Date.now();
  const slow = await worker.invoke({ ...call, step: "timeout", timeoutSec: 2 });
  const elapsedSec = (Date.now() - startedAt) / 1000;
  report(
    slow.status === "failed" && slow.summary.includes("時間の上限"),
    "上限を過ぎると failed になる",
    describe(slow),
  );
  report(elapsedSec < 60, "上限の後、すぐに返る", `${elapsedSec.toFixed(1)}秒`);
  report(logKept(slow), "時間切れの場合も、ログが残る", slow.logPath);

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
