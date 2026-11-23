/**
 * verify: 製品の検査コマンド(setup、test、lint)を実行して、合否を決める。
 *
 * ワーカーの申告には頼らない。コマンドは製品のコードを実行するので、事務局の中ではなく、
 * 起動係を通して、ワーカーと同じ種類のコンテナで動かす。コンテナに渡る環境変数は起動係が決め、
 * 依頼では指定できない。Claudeのトークンは求めない。
 *
 * コマンドは、作業場所のファイルではなく、事務局が同期して保存した `factory.yml` から読む。
 * 作業場所のファイルはワーカーが書き換えられ、検査そのものを差し替えられるからである。
 *
 * コマンドが検査するのは作業場所のファイルで、PRに入るのはコミットされた内容である。
 * 食い違ったまま合格にしないように、コマンドの前に、コミットされていない内容が残っていないことを
 * 確かめる。確かめるためのgitも、事務局の中ではなく、起動係を通したコンテナの中で実行する。
 * 作業場所のgit設定はワーカーが書き換えられ、事務局の権限でコマンドを起動できるからである。
 */
import fs from "node:fs";
import path from "node:path";
import {
  LauncherAbortedError,
  type WorkerLauncher,
} from "../launcher/client.ts";
import { MAX_TIMEOUT_SEC, type RunResult } from "../launcher/request.ts";
import { type Clock, systemClock } from "./clock.ts";
import type { Db } from "./db.ts";
import { type FactoryYml, readStoredFactoryYml } from "./product.ts";
import { maskSecrets, stepLogDir, writeStepLog } from "./step-log.ts";
import { type WorkspaceDirs, workspacePaths } from "./workspace.ts";

/** 検査コマンドの名前。この順に実行する。 */
export const VERIFY_COMMANDS = ["setup", "test", "lint"] as const;
export type VerifyCommandName = (typeof VERIFY_COMMANDS)[number];

/**
 * 作業場所の状態を確かめるコマンド。コンテナの中の、製品のcloneで実行する。
 *
 * - 出力は、パスごとにNULで区切る(`-z`)。パスは引用されない。
 * - 追跡していないファイルは、ディレクトリにまとめずに1つずつ挙げる。無視対象は挙げない。
 * - 改名は1つにまとめず、消したパスと足したパスに分ける(1項目が1パスになる)。
 * - 確かめるだけで、インデックスを書き換えない(`--no-optional-locks`)。
 */
export const STATUS_ARGV = [
  "git",
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--no-renames",
] as const;

/** 状態の確認の時間の上限(秒)。検査コマンドの上限のほうが短ければ、そちらを使う。 */
const STATUS_TIMEOUT_SEC = 5 * 60;

/** 結果に載せる、コミットされていないパスの数の上限。件数は、別に残す。 */
export const MAX_UNCOMMITTED_PATHS = 50;

/** 結果に載せる、パス1つの長さの上限(文字数)。 */
const MAX_PATH_CHARS = 300;

/** 結果に載せる、失敗したコマンドの出力の長さの上限(文字数)。 */
const MAX_TAIL_CHARS = 4000;

/** コマンド1つの結果。 */
export interface VerifyCommandResult {
  readonly name: VerifyCommandName;
  /** 実行した(または実行しなかった)コマンド。 */
  readonly command: string;
  /**
   * - `passed`: 終了コード0で終わった。
   * - `failed`: 0以外の終了コードで終わった。
   * - `timed_out`: 時間の上限に達したので、コンテナごと止めた。
   * - `not_run`: 起動係がコマンドを実行できなかった(依頼の拒否、起動係に届かない)。
   * - `interrupted`: 実行の途中で、依頼した側が止めた(事務局の停止)。結果は受け取っていない。
   * - `skipped`: 先のコマンドの結果を受けて、実行しなかった。
   */
  readonly status:
    | "passed"
    | "failed"
    | "timed_out"
    | "not_run"
    | "interrupted"
    | "skipped";
  /** 終了コード。実行しなかった場合と、シグナルで終わった場合は null。 */
  readonly exitCode: number | null;
  /** 所要時間(ミリ秒)。コンテナの起動と片付けを含む。実行しなかった場合は null。 */
  readonly durationMs: number | null;
  /** 出力が大きすぎて、途中で切られたか。 */
  readonly truncated: boolean;
  /**
   * 合格しなかった場合の、出力の末尾(標準出力、標準エラーの順)。
   * 差し戻しのときに、implement へ渡せる。全文はログにある。
   */
  readonly outputTail: string;
}

/**
 * verify の結果。チェックポイント(`steps.output`)に残せる形にしてある。
 *
 * - `done`: すべてのコマンドが終了コード0で終わった(合格)。
 * - `rework`: 終了コードが0でないコマンド、または時間切れのコマンドがあった(不合格)。
 *   または、作業場所にコミットされていない内容が残っていて、コマンドを実行しなかった。
 *   implement に差し戻す。
 * - `failed`: コマンドを実行できなかった、または作業場所の状態を確かめられなかった。
 *   製品の側の失敗ではないので、差し戻さない。
 */
export interface VerifyResult {
  readonly outcome: "done" | "rework" | "failed";
  readonly passed: boolean;
  readonly summary: string;
  /** 合格しなかったコマンドの名前(実行しなかったものは含まない)。 */
  readonly failedCommands: readonly VerifyCommandName[];
  readonly commands: readonly VerifyCommandResult[];
  /**
   * 作業場所に残っていた、コミットされていないパス(変更と、追跡していないファイル)。
   * 多いときは先頭の `MAX_UNCOMMITTED_PATHS` 件だけ。差し戻しのときに、implement へ渡す。
   */
  readonly uncommittedPaths: readonly string[];
  /** 残っていたパスの数(載せなかったものを含む)。 */
  readonly uncommittedCount: number;
  /** この実行のログのファイル。 */
  readonly logPath: string;
  /**
   * 途中で、依頼した側が止めた(事務局の停止)。
   * `outcome` は `failed` だが、検査が失敗したわけではない。ログには `interrupted` と残る。
   */
  readonly interrupted: boolean;
}

/** 中断した検査の要約。実行できなかった場合や、確かめられなかった場合とは別の文にする。 */
export const INTERRUPTED_SUMMARY =
  "検査を中断しました(事務局の停止)。結果は受け取っていません";

/** コンテナの中で実行するコマンドを組み立てる純粋関数。 */
export function buildVerifyArgv(command: string): string[] {
  return ["sh", "-c", command];
}

/**
 * `git status --porcelain=v1 -z --no-renames` の出力から、パスを取り出す純粋関数。
 *
 * 項目は「状態の2文字、空白、パス」で、NULで区切られている。想定外の形の項目は、
 * 捨てずにそのまま残す(残っているものを、ないものとして扱わないため)。
 */
export function parseStatusPaths(stdout: string): string[] {
  return stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) =>
      entry.length > 3 && entry[2] === " " ? entry.slice(3) : entry,
    );
}

/**
 * 作業場所の状態。
 *
 * - `clean`: コミットされていない内容がない。
 * - `dirty`: コミットしていない変更か、追跡していないファイルがある。
 * - `unknown`: 確かめられなかった。
 * - `interrupted`: 確かめている途中で、依頼した側が止めた(事務局の停止)。
 */
export type WorkspaceStatus =
  | { readonly status: "clean" }
  | { readonly status: "interrupted" }
  | { readonly status: "dirty"; readonly paths: readonly string[] }
  | { readonly status: "unknown"; readonly reason: string };

/** 起動係の結果(状態の確認)を、作業場所の状態にする純粋関数。 */
export function interpretStatus(run: RunResult): WorkspaceStatus {
  if (run.timed_out) {
    return { status: "unknown", reason: "時間の上限に達しました" };
  }
  if (run.exit_code !== 0) {
    return {
      status: "unknown",
      reason: `git status が終了コード ${String(run.exit_code)} で終わりました: ${outputTail(run.stderr)}`,
    };
  }
  // 出力が途中で切られていても、読めた分のパスがあるので、残っているものとして扱う。
  const paths = parseStatusPaths(run.stdout);
  return paths.length === 0 ? { status: "clean" } : { status: "dirty", paths };
}

/** 結果に載せるパス。トークンに見える文字列を伏せ、長すぎるものは切る。 */
function displayPath(value: string): string {
  const masked = maskSecrets(value);
  return masked.length <= MAX_PATH_CHARS
    ? masked
    : `${masked.slice(0, MAX_PATH_CHARS)}…`;
}

/** 起動係の結果を、コマンド1つの結果にする純粋関数。 */
export function interpretCommand(
  name: VerifyCommandName,
  command: string,
  run: RunResult,
  durationMs: number,
): VerifyCommandResult {
  const status = run.timed_out
    ? "timed_out"
    : run.exit_code === 0
      ? "passed"
      : "failed";
  return {
    name,
    command,
    status,
    exitCode: run.exit_code,
    durationMs,
    truncated: run.truncated,
    outputTail:
      status === "passed" ? "" : outputTail(`${run.stdout}\n${run.stderr}`),
  };
}

function outputTail(text: string): string {
  const trimmed = maskSecrets(text).trim();
  return trimmed.length <= MAX_TAIL_CHARS
    ? trimmed
    : `…${trimmed.slice(-MAX_TAIL_CHARS)}`;
}

/**
 * 先のコマンドの結果を見て、次のコマンドを実行するかを決める純粋関数。
 *
 * setup が通らなければ、残りは実行しない(準備のできていない場所での結果は当てにならない)。
 * test が通らなくても、lint は実行する(1回の差し戻しで、両方の指摘を渡すため)。
 * コマンドを実行できなかった場合と、中断した場合は、その先も実行しない。
 */
export function shouldRun(previous: readonly VerifyCommandResult[]): boolean {
  return previous.every(
    (result) =>
      result.status === "passed" ||
      (result.name !== "setup" &&
        (result.status === "failed" || result.status === "timed_out")),
  );
}

/** コマンドごとの結果から、全体の結果を決める純粋関数。 */
export function judgeVerify(
  commands: readonly VerifyCommandResult[],
  timeoutSec: number,
): Pick<VerifyResult, "outcome" | "passed" | "summary" | "failedCommands"> {
  if (commands.some((result) => result.status === "interrupted")) {
    return {
      outcome: "failed",
      passed: false,
      summary: INTERRUPTED_SUMMARY,
      failedCommands: [],
    };
  }
  const notRun = commands.find((result) => result.status === "not_run");
  if (notRun !== undefined) {
    return {
      outcome: "failed",
      passed: false,
      summary: `検査コマンド ${notRun.name} を実行できませんでした: ${notRun.outputTail}`,
      failedCommands: [],
    };
  }
  const failures = commands.filter(
    (result) => result.status === "failed" || result.status === "timed_out",
  );
  if (failures.length === 0) {
    return {
      outcome: "done",
      passed: true,
      summary: "すべての検査コマンドが、終了コード0で終わりました",
      failedCommands: [],
    };
  }
  const details = failures.map((result) =>
    result.status === "timed_out"
      ? `${result.name}(時間の上限 ${timeoutSec}秒に達したので止めました)`
      : `${result.name}(終了コード ${String(result.exitCode)})`,
  );
  const skipped = commands
    .filter((result) => result.status === "skipped")
    .map((result) => result.name);
  const suffix =
    skipped.length === 0 ? "" : `。実行しなかったもの: ${skipped.join("、")}`;
  return {
    outcome: "rework",
    passed: false,
    summary: `検査コマンドが失敗しました: ${details.join("、")}${suffix}`,
    failedCommands: failures.map((result) => result.name),
  };
}

/** 作業場所がきれいでなかった場合の、全体の結果を決める純粋関数。 */
export function judgeWorkspace(
  workspace: Exclude<WorkspaceStatus, { status: "clean" }>,
): Pick<VerifyResult, "outcome" | "passed" | "summary" | "failedCommands"> {
  if (workspace.status === "interrupted") {
    return {
      outcome: "failed",
      passed: false,
      summary: INTERRUPTED_SUMMARY,
      failedCommands: [],
    };
  }
  if (workspace.status === "unknown") {
    return {
      outcome: "failed",
      passed: false,
      summary: `作業場所の状態を確かめられませんでした: ${workspace.reason}`,
      failedCommands: [],
    };
  }
  return {
    outcome: "rework",
    passed: false,
    summary: `作業場所に、コミットされていない内容(変更、または追跡していないファイル)が${workspace.paths.length}件残っているので、検査コマンドを実行しませんでした。検査の対象になるのは、コミットされた内容だけです。必要なものはコミットし、不要なものは元に戻すか消してください`,
    failedCommands: [],
  };
}

export interface VerifyDeps {
  readonly db: Db;
  /** 起動係に依頼する口。テストでは、偽の実装に差し替える。 */
  readonly launcher: WorkerLauncher;
  /** 置き場所(設定の `repos_dir`、`work_dir`)。 */
  readonly dirs: WorkspaceDirs;
  /** ログの置き場所(設定の `logs_dir`)。 */
  readonly logsDir: string;
  readonly clock?: Clock;
}

export interface VerifyInput {
  /** 対象のリポジトリ(owner/name)。設定にある書き方で渡す。 */
  readonly repo: string;
  readonly issue: number;
  /** コマンド1つごとの時間の上限(秒)。過ぎたら、起動係がコンテナごと止める。 */
  readonly timeoutSec: number;
}

/** 作業場所のcloneがあることを確かめる。シンボリックリンクはたどらない。 */
function assertWorkspace(repoDir: string, repo: string, issue: number): void {
  const isDir = (target: string) =>
    fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!isDir(repoDir) || !isDir(path.join(repoDir, ".git"))) {
    throw new Error(
      `リポジトリ ${repo} のイシュー ${issue} の作業場所が未取得です(cloneがありません: ${repoDir})。先に prepare を行ってください`,
    );
  }
}

function logText(
  header: Record<string, unknown>,
  outputs: readonly { name: string; run: RunResult | null }[],
): string {
  const lines = [JSON.stringify(header, null, 2)];
  for (const { name, run } of outputs) {
    lines.push(`--- ${name} stdout ---`, run?.stdout ?? "");
    lines.push(`--- ${name} stderr ---`, run?.stderr ?? "");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 検査コマンドを順に実行し、合否とログの場所を返す。
 *
 * 最初に作業場所の状態を確かめ、コミットされていない内容が残っていれば、コマンドを
 * 1つも実行せずに `rework` を返す。確かめられなかった場合は `failed` を返す。
 *
 * コマンドの失敗と時間切れは、例外ではなく結果(`rework`)として返る。
 * 途中で止められた場合も、例外ではなく `interrupted` を立てて返る。
 * 例外になるのは、実行を始められない場合(`factory.yml` が未取得または不正、作業場所がない、
 * 時間の上限が範囲の外)と、ログを書けない場合だけで、そのときコマンドは1つも実行しない。
 *
 * やり直して安全で、呼ぶたびに新しいログのファイルを作る。
 */
export async function runVerify(
  deps: VerifyDeps,
  input: VerifyInput,
): Promise<VerifyResult> {
  const clock = deps.clock ?? systemClock;
  const { repo, issue, timeoutSec } = input;
  if (
    !Number.isInteger(timeoutSec) ||
    timeoutSec < 1 ||
    timeoutSec > MAX_TIMEOUT_SEC
  ) {
    throw new Error(
      `検査コマンドの時間の上限が不正です: ${String(timeoutSec)}(1から${MAX_TIMEOUT_SEC}の整数)`,
    );
  }
  const factoryYml: FactoryYml = readStoredFactoryYml(deps.db, repo);
  const paths = workspacePaths(deps.dirs, repo, issue);
  assertWorkspace(paths.repoDir, repo, issue);
  const logDir = stepLogDir(deps.logsDir, repo, issue);

  const startedAt = clock.now();
  const results: VerifyCommandResult[] = [];
  const outputs: { name: string; run: RunResult | null }[] = [];

  // 先に、コミットされていない内容が残っていないことを確かめる。
  let workspace: WorkspaceStatus;
  try {
    const run = await deps.launcher.run({
      repo,
      issue,
      argv: [...STATUS_ARGV],
      claude_token: false,
      timeout_sec: Math.min(timeoutSec, STATUS_TIMEOUT_SEC),
    });
    workspace = interpretStatus(run);
    // ログでは、区切りのNULを改行にする。
    outputs.push({
      name: "status",
      run: { ...run, stdout: run.stdout.replaceAll("\0", "\n") },
    });
  } catch (error) {
    // 止められた場合は、確かめられなかった場合(依頼の拒否、起動係に届かない)と分ける。
    if (error instanceof LauncherAbortedError) {
      workspace = { status: "interrupted" };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      workspace = { status: "unknown", reason: outputTail(message) };
    }
    outputs.push({ name: "status", run: null });
  }

  for (const name of VERIFY_COMMANDS) {
    const command = factoryYml.commands[name];
    if (workspace.status !== "clean" || !shouldRun(results)) {
      results.push({
        name,
        command,
        status: "skipped",
        exitCode: null,
        durationMs: null,
        truncated: false,
        outputTail: "",
      });
      continue;
    }
    const commandStartedAt = clock.now();
    try {
      const run = await deps.launcher.run({
        repo,
        issue,
        argv: buildVerifyArgv(command),
        // 製品のテストを実行するコンテナには、Claudeのトークンを渡さない。
        claude_token: false,
        timeout_sec: timeoutSec,
      });
      const durationMs = clock.now().getTime() - commandStartedAt.getTime();
      results.push(interpretCommand(name, command, run, durationMs));
      outputs.push({ name, run });
    } catch (error) {
      // 止められた場合と、依頼を拒否された場合と、起動係に届かない場合。
      const interrupted = error instanceof LauncherAbortedError;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name,
        command,
        status: interrupted ? "interrupted" : "not_run",
        exitCode: null,
        durationMs: null,
        truncated: false,
        outputTail: interrupted ? "" : outputTail(message),
      });
      outputs.push({ name, run: null });
    }
  }
  const finishedAt = clock.now();

  const uncommittedCount =
    workspace.status === "dirty" ? workspace.paths.length : 0;
  const uncommittedPaths =
    workspace.status === "dirty"
      ? workspace.paths.slice(0, MAX_UNCOMMITTED_PATHS).map(displayPath)
      : [];
  const judged =
    workspace.status === "clean"
      ? judgeVerify(results, timeoutSec)
      : judgeWorkspace(workspace);
  const interrupted =
    workspace.status === "interrupted" ||
    results.some((result) => result.status === "interrupted");
  const header = {
    repo,
    issue,
    step: "verify",
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    timeout_sec: timeoutSec,
    // 中断は、検査の失敗と区別して残す。
    outcome: interrupted ? "interrupted" : judged.outcome,
    summary: judged.summary,
    workspace: {
      status: workspace.status,
      uncommitted_count: uncommittedCount,
    },
    commands: results.map((result) => ({
      name: result.name,
      command: result.command,
      status: result.status,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      truncated: result.truncated,
    })),
  };
  const logPath = writeStepLog({
    dir: logDir,
    startedAt,
    step: "verify",
    text: logText(header, outputs),
  });
  return {
    ...judged,
    commands: results,
    uncommittedPaths,
    uncommittedCount,
    logPath,
    interrupted,
  };
}
