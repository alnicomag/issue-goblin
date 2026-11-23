/**
 * 指示書(plan、implement、review)の確認。事務局のコンテナの中で実行する。
 *
 * 仮の小さな製品を取得元にして、prepare で作業場所を用意し、起動係を通してワーカーのコンテナで
 * 3つの指示書を順に1回ずつ実際に呼び出して、形式どおりの結果が返ることを確かめる。
 * implement と review が done を返したときは、要約が決めた見出しを持つことも確かめる。
 * 項目ごとに合否を出し、1つでも不合格なら、終了コード1で終わる。
 *
 * 実際のClaudeのトークンを使う(サブスクリプションの枠を使う)。
 * 置き場所に確認用のミラーと作業場所を作るので、稼働中の環境ではなく、
 * scripts/check-prompts.sh が立てる確認用の環境で実行すること。
 *
 * ここに書く製品の中身(ファイル、コマンド、イシュー)は、確認のための仮のものである。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROMPTS_DIR } from "../src/agents/prompts.ts";
import { allowedStatuses } from "../src/agents/schemas.ts";
import {
  createClaudeWorker,
  type WorkerInvocation,
} from "../src/agents/worker.ts";
import { createLauncherClient } from "../src/launcher/client.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/office/config.ts";
import { createGit } from "../src/office/git.ts";
import { parseFactoryYml } from "../src/office/product.ts";
import {
  cleanupWorkspace,
  type PreparedWorkspace,
  prepareWorkspace,
} from "../src/office/workspace.ts";
import {
  checkJudgementTable,
  checkSummaryHeadings,
  SUMMARY_HEADINGS,
  type SummaryCheck,
} from "./summary-headings.ts";

/** 確認に使うイシュー番号。ほかの確認が使う番号と重ならないようにする。 */
const ISSUE = 960;

/** 仮の製品。依存がなく、ワーカーのイメージにあるNodeだけでテストできる。 */
const FACTORY_YML = `version: 1
level: A
commands:
  setup: "true"
  test: node --test
  lint: node --check src/greet.js
paths:
  protected:
    - factory.yml
    - CLAUDE.md
  forbidden:
    - docs/**
issues:
  allowed_authors:
    - example
`;

const PRODUCT_FILES: Record<string, string> = {
  "factory.yml": FACTORY_YML,
  "package.json": `${JSON.stringify({ name: "example", private: true, type: "module" }, null, 2)}\n`,
  "CLAUDE.md": [
    "# example",
    "",
    "- テストは `test/` に、`node:test` で書く。",
    "- コミットメッセージは英語で、1行にする。",
    "- 依存を追加しない。",
    "",
  ].join("\n"),
  "docs/spec.md": "# 仕様\n\n`greet(name)` は、あいさつの文字列を返す。\n",
  "src/greet.js":
    'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n',
  "test/greet.test.js": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { greet } from "../src/greet.js";',
    "",
    'test("名前を入れてあいさつする", () => {',
    '  assert.equal(greet("Ada"), "Hello, Ada!");',
    "});",
    "",
  ].join("\n"),
};

const ISSUE_TEXT = `タイトル: greet が、空の名前を受け取ったときの返り値を決める

## 背景

\`greet("")\` が \`Hello, !\` を返す。

## 受け入れ条件

- [ ] \`greet("")\` と、空白だけの名前は、\`Hello, stranger!\` を返す。
- [ ] 名前の前後の空白は、取り除いてから使う(\`greet(" Ada ")\` は \`Hello, Ada!\`)。
- [ ] 上の2つを確かめるテストがある。
- [ ] 既存のテストが通る。

## 範囲外

- 文字列以外の引数の扱い
- \`docs/\` の更新

コメント: なし
`;

let failures = 0;
function report(ok: boolean, item: string, detail = ""): void {
  if (!ok) failures += 1;
  const suffix = detail === "" ? "" : `: ${detail}`;
  console.log(`${ok ? "OK" : "NG"}  ${item}${ok ? "" : suffix}`);
}

function describe(result: WorkerInvocation): string {
  return `status=${result.status} summary=${JSON.stringify(result.summary.slice(0, 600))}`;
}

function show(result: WorkerInvocation): void {
  console.log(
    `      (状態: ${result.status}、金額: ${String(result.costUsd)} 米ドル、ターン数: ${String(result.numTurns)}、ログ: ${result.logPath})`,
  );
  for (const line of result.summary.split("\n").slice(0, 40)) {
    console.log(`      | ${line}`);
  }
}

/** 見出しの確認の結果を、合否として出す。 */
function reportSummary(
  check: SummaryCheck,
  item: string,
  summary: string,
): void {
  report(
    check.ok,
    item,
    check.ok
      ? ""
      : `${check.reason} summary=${JSON.stringify(summary.slice(0, 600))}`,
  );
}

/**
 * 守りを付けない素のgit。取得元になる仮の製品を作るときにだけ使う。
 * ここで渡す作者は、取得元の最初のコミットのもので、作業場所には引き継がれない。
 */
function sourceGit(cwd: string, ...args: string[]): void {
  execFileSync(
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
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
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
  if (!parseFactoryYml(FACTORY_YML).ok) {
    throw new Error("確認用の factory.yml が、検証を通りません");
  }

  // 仮の製品を取得元にして、事務局と同じ方法(prepare)で作業場所を用意する。
  // コミットの作者も、prepare が設定から入れる。ここでは設定しない。
  const git = createGit();
  const input = {
    dirs: { reposDir: config.repos_dir, workDir: config.work_dir },
    repo: first.repo,
    issue: ISSUE,
  };
  cleanupWorkspace(input);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-check-"));
  let workspace: PreparedWorkspace;
  try {
    const source = path.join(tmp, "source");
    for (const [file, content] of Object.entries(PRODUCT_FILES)) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.writeFileSync(path.join(source, file), content);
    }
    sourceGit(source, "init", "--quiet", "--initial-branch=main");
    sourceGit(source, "add", "--all");
    sourceGit(source, "commit", "--quiet", "-m", "initial");
    workspace = await prepareWorkspace(
      { git },
      { ...input, source: { url: source }, author: config.commit_author },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 確認用に作ったミラーは、作業場所ができれば要らない。
  fs.rmSync(workspace.mirrorDir, { recursive: true, force: true });
  const { repoDir, branch } = workspace;

  // ここから先は、ワーカーが書き換えられるリポジトリなので、守りを付けたgitで読む。
  const read = async (...args: string[]): Promise<string> =>
    (await git.run(args, { cwd: repoDir })).trim();
  const state = async () => ({
    head: await read("rev-parse", "HEAD"),
    branch: await read("symbolic-ref", "--short", "HEAD"),
    dirty: await read("status", "--porcelain"),
  });
  const base = await read("rev-parse", "main");

  const launcher = createLauncherClient({ socketPath });
  const worker = createClaudeWorker({
    launcher,
    promptsDir: DEFAULT_PROMPTS_DIR,
    logsDir: config.logs_dir,
  });
  const common = { repo: first.repo, issue: ISSUE };
  const formatted = (result: WorkerInvocation, prompt: string): boolean =>
    allowedStatuses(prompt).includes(result.status) &&
    result.summary.trim() !== "" &&
    result.sessionId !== null;

  console.log("# plan");
  const plan = await worker.invoke({
    ...common,
    step: "plan",
    prompt: "plan",
    values: { issue: ISSUE_TEXT, factory_yml: FACTORY_YML },
    timeoutSec: 900,
    maxTurns: 40,
  });
  show(plan);
  report(formatted(plan, "plan"), "形式どおりの結果が返る", describe(plan));
  report(plan.status === "done", "計画が返る(done)", describe(plan));
  const afterPlan = await state();
  report(
    afterPlan.head === base &&
      afterPlan.branch === branch &&
      afterPlan.dirty === "",
    "plan は、ファイルを変更せず、コミットもしない",
    JSON.stringify(afterPlan),
  );

  console.log("\n# implement");
  const implement = await worker.invoke({
    ...common,
    step: "implement",
    prompt: "implement",
    values: {
      issue: ISSUE_TEXT,
      factory_yml: FACTORY_YML,
      plan: plan.summary,
      feedback: "",
    },
    timeoutSec: 1200,
    maxTurns: 80,
  });
  show(implement);
  report(
    formatted(implement, "implement"),
    "形式どおりの結果が返る",
    describe(implement),
  );
  report(
    implement.status === "done",
    "実装が終わる(done)",
    describe(implement),
  );
  if (implement.status === "done") {
    reportSummary(
      checkSummaryHeadings(implement.summary, SUMMARY_HEADINGS.implement),
      `要約が、見出し(${SUMMARY_HEADINGS.implement.join("、")})をこの順で持つ`,
      implement.summary,
    );
  }
  const afterImplement = await state();
  const commits = await read("rev-list", "--count", `${base}..HEAD`);
  report(
    Number(commits) >= 1 && afterImplement.branch === branch,
    "イシュー用のブランチに、コミットがある",
    `コミット数=${commits} ブランチ=${afterImplement.branch}`,
  );
  report(
    afterImplement.dirty === "",
    "コミットしていない変更が残っていない",
    afterImplement.dirty,
  );
  report(
    (await read("rev-parse", "main")) === base,
    "既定のブランチは、変わっていない",
  );
  const expectedAuthor = `${config.commit_author.name} <${config.commit_author.email}>`;
  const authors = [
    ...new Set(
      (await read("log", "--format=%an <%ae>%n%cn <%ce>", `${base}..HEAD`))
        .split("\n")
        .filter((line) => line !== ""),
    ),
  ];
  report(
    authors.length === 1 && authors[0] === expectedAuthor,
    `コミットの作者が、設定の値(${expectedAuthor})になっている`,
    JSON.stringify(authors),
  );
  const messages = (await read("log", "--format=%B%x00", `${base}..HEAD`))
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
  report(
    messages.every((message) => !message.includes("\n")),
    "コミットメッセージが、製品の規約(1行)に従っている",
    JSON.stringify(messages),
  );
  const changed = (await read("diff", "--name-only", `${base}..HEAD`))
    .split("\n")
    .filter((file) => file !== "");
  console.log(`      (変更されたファイル: ${changed.join(", ")})`);
  report(
    !changed.some((file) => file.startsWith("docs/")),
    "paths.forbidden のパスを変更していない",
    changed.join(", "),
  );
  report(
    !changed.some((file) => file === "factory.yml" || file === "CLAUDE.md"),
    "paths.protected のパスを変更していない(このイシューには不要)",
    changed.join(", "),
  );
  report(
    (await read("remote")) === "" &&
      !fs.existsSync(path.join(repoDir, ".git", "hooks", "pre-commit")),
    "リモートとフックを足していない",
  );

  // verify に当たる部分。Claudeのトークンを渡さないコンテナで、製品のテストとlintを実行する。
  console.log("\n# テストとlint(ワーカーのコンテナで実行する)");
  const results: string[] = [];
  let verified = true;
  for (const argv of [
    ["node", "--test"],
    ["node", "--check", "src/greet.js"],
  ]) {
    const run = await launcher.run({ ...common, argv, timeout_sec: 300 });
    verified &&= run.exit_code === 0;
    results.push(
      `$ ${argv.join(" ")}\n終了コード: ${String(run.exit_code)}\n${run.stdout}${run.stderr}`,
    );
  }
  const testResult = results.join("\n");
  report(verified, "実装の後、テストとlintが通る", testResult.slice(-1500));

  console.log("\n# review");
  const review = await worker.invoke({
    ...common,
    step: "review",
    prompt: "review",
    values: {
      issue: ISSUE_TEXT,
      factory_yml: FACTORY_YML,
      diff: await read("diff", `${base}..HEAD`),
      test_result: testResult,
    },
    timeoutSec: 900,
    maxTurns: 40,
  });
  show(review);
  report(
    formatted(review, "review"),
    "形式どおりの結果が返る",
    describe(review),
  );
  report(
    review.status === "done" || review.status === "rework",
    "判定が返る(done か rework)",
    describe(review),
  );
  if (review.status === "done") {
    reportSummary(
      checkSummaryHeadings(review.summary, SUMMARY_HEADINGS.review),
      `要約が、見出し(${SUMMARY_HEADINGS.review.join("、")})をこの順で持つ`,
      review.summary,
    );
    reportSummary(
      checkJudgementTable(review.summary),
      "「受け入れ条件ごとの判定」が、条件、判定、根拠の表である",
      review.summary,
    );
  } else {
    // 見出しを決めているのは done のときだけなので、ここでは確かめられない。
    console.log(
      `未確認  review の要約の見出し(状態が ${review.status} なので、確かめていない)`,
    );
  }
  const afterReview = await state();
  report(
    afterReview.head === afterImplement.head && afterReview.dirty === "",
    "review は、ファイルを変更せず、コミットもしない",
    JSON.stringify(afterReview),
  );

  const total = [plan, implement, review].reduce(
    (sum, result) => sum + (result.costUsd ?? 0),
    0,
  );
  console.log(`\n金額の合計(定価で計算した参考値): ${total.toFixed(2)} 米ドル`);
  console.log(
    failures === 0 ? "すべて合格しました" : `不合格が ${failures} 件あります`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
