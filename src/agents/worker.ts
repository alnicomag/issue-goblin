/**
 * ワーカー(plan、implement、review)の呼び出し。
 *
 * 事務局は、指示書と入力を渡し、決まった形式の結果を受け取る。
 * ステップを進める側は `WorkerInvoker` だけを見る。テストでは、偽の実装に差し替える。
 */
import { z } from "zod";
import {
  LauncherAbortedError,
  type WorkerLauncher,
} from "../launcher/client.ts";
import {
  MAX_TIMEOUT_SEC,
  type RunRequestInput,
  type RunResult,
} from "../launcher/request.ts";
import { type Clock, systemClock } from "../office/clock.ts";
import { formatZodError } from "../office/config.ts";
import { maskSecrets, stepLogDir, writeStepLog } from "../office/step-log.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import {
  allowedStatuses,
  ClaudeResultSchema,
  WorkerOutputSchema,
  type WorkerStatus,
  workerOutputJsonSchema,
} from "./schemas.ts";

/** 失敗の理由に載せる、標準エラーや発言の長さの上限(文字数)。 */
const MAX_DETAIL_CHARS = 2000;

/** 起動係の結果を解釈したもの。 */
export interface WorkerOutcome {
  readonly status: WorkerStatus;
  /** ワーカーの要約。事務局が `failed` にした場合は、その理由。 */
  readonly summary: string;
  /** Claude Codeのセッション。読み取れなかった場合は null。 */
  readonly sessionId: string | null;
  /**
   * `claude -p` が返した金額(米ドル)。読み取れなかった場合は null。
   * サブスクリプションでは請求額ではなく、定価で計算した参考値である。
   */
  readonly costUsd: number | null;
  /** 使ったターン数。読み取れなかった場合は null。 */
  readonly numTurns: number | null;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_DETAIL_CHARS
    ? trimmed
    : `…${trimmed.slice(-MAX_DETAIL_CHARS)}`;
}

function withDetail(message: string, detail: string | undefined): string {
  const text = detail === undefined ? "" : tail(detail);
  return text === "" ? message : `${message}: ${text}`;
}

/**
 * 起動係が返した実行結果を、ワーカーの結果として解釈する純粋関数。
 *
 * 形式に合わない出力、返せない状態、時間切れ、ターン数の上限は、理由の分かる要約を付けて
 * `failed` にする。例外は投げない。
 */
export function interpretRun(
  run: RunResult,
  limits: { timeoutSec: number; statuses: readonly WorkerStatus[] },
): WorkerOutcome {
  const failed = (
    summary: string,
    known: Partial<WorkerOutcome> = {},
  ): WorkerOutcome => ({
    sessionId: null,
    costUsd: null,
    numTurns: null,
    ...known,
    status: "failed",
    summary: maskSecrets(summary),
  });

  if (run.timed_out) {
    return failed(
      `時間の上限(${limits.timeoutSec}秒)に達したので、ワーカーを止めました`,
    );
  }
  if (run.truncated) {
    return failed("ワーカーの出力が大きすぎて、途中で切られました");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(run.stdout);
  } catch {
    if (run.exit_code !== 0) {
      return failed(
        withDetail(
          `claude が失敗しました(終了コード ${String(run.exit_code)})`,
          run.stderr,
        ),
      );
    }
    return failed(
      withDetail("ワーカーの出力をJSONとして読めません", run.stdout),
    );
  }

  const envelope = ClaudeResultSchema.safeParse(raw);
  if (!envelope.success) {
    return failed(
      `claude の出力の形式が不正です:\n${formatZodError(envelope.error)}`,
    );
  }
  const result = envelope.data;
  const known = {
    sessionId: result.session_id ?? null,
    costUsd: result.total_cost_usd ?? null,
    numTurns: result.num_turns ?? null,
  };

  if (result.subtype === "error_max_turns") {
    return failed(
      withDetail(
        "ターン数の上限に達したので、ワーカーが止まりました",
        result.errors?.join(" / "),
      ),
      known,
    );
  }
  if (result.is_error || result.subtype !== "success") {
    return failed(
      withDetail(
        `claude が失敗を返しました(${result.subtype})`,
        result.errors?.join(" / ") ?? result.result,
      ),
      known,
    );
  }
  if (run.exit_code !== 0) {
    return failed(
      withDetail(
        `claude が失敗しました(終了コード ${String(run.exit_code)})`,
        run.stderr,
      ),
      known,
    );
  }
  if (result.structured_output === undefined) {
    return failed(
      withDetail(
        "ワーカーが、決まった形式の結果(structured_output)を返しませんでした",
        result.result,
      ),
      known,
    );
  }

  const output = WorkerOutputSchema.safeParse(result.structured_output);
  if (!output.success) {
    return failed(
      `ワーカーの結果の形式が不正です:\n${formatZodError(output.error)}`,
      known,
    );
  }
  if (!limits.statuses.includes(output.data.status)) {
    return failed(
      withDetail(
        `ワーカーが、この指示書では返せない状態(${output.data.status})を返しました`,
        output.data.summary,
      ),
      known,
    );
  }
  return {
    ...known,
    status: output.data.status,
    summary: maskSecrets(output.data.summary),
  };
}

/** 中断した呼び出しの要約。起動の失敗(`ワーカーを起動できませんでした`)とは別の文にする。 */
export const INTERRUPTED_SUMMARY =
  "ワーカーの呼び出しを中断しました(事務局の停止)。ワーカーの結果は受け取っていません";

/** 1回の呼び出しの内容。 */
export interface WorkerCall {
  /** 対象のリポジトリ(owner/name)。設定にある書き方で渡す。 */
  readonly repo: string;
  readonly issue: number;
  /** ステップの名前。ログのファイル名に使う。 */
  readonly step: string;
  /** 指示書の名前。`prompts/<名前>.md` を読む。 */
  readonly prompt: string;
  /**
   * 指示書に差し込む値(イシューの本文、差分など)。名前は、指示書の `{{名前}}` に対応する。
   * 指示書にある名前が欠けていても、指示書にない名前があっても、呼び出しの前に失敗する。
   */
  readonly values: Readonly<Record<string, string>>;
  /** この秒数を過ぎたら、起動係がコンテナごと止める。 */
  readonly timeoutSec: number;
  /** ターン数の上限。 */
  readonly maxTurns: number;
}

/** 呼び出しの結果。`steps` に記録できる形にしてある。 */
export interface WorkerInvocation extends WorkerOutcome {
  /** この呼び出しのログのファイル。 */
  readonly logPath: string;
  /**
   * 呼び出しの途中で、依頼した側が止めた(事務局の停止)。
   * `status` は `failed` だが、ワーカーが失敗したわけではない。ログには `interrupted` と残る。
   */
  readonly interrupted: boolean;
}

export interface WorkerInvoker {
  /**
   * ワーカーを1回呼び出し、終わるまで待つ。
   *
   * ワーカーの側で起きた失敗(時間切れ、形式に合わない出力、起動係に届かないなど)は、
   * 例外ではなく `failed` として返る。途中で止められた場合も、例外ではなく `interrupted` を立てて返る。
   * 例外になるのは、呼び出しの内容そのものが
   * 不正な場合(指示書がない、差し込む値が欠けている、上限が範囲の外など)と、ログを書けない場合だけである。
   */
  invoke(call: WorkerCall): Promise<WorkerInvocation>;
}

const WorkerCallSchema = z.strictObject({
  repo: z.string().min(1),
  issue: z.number().int().min(1),
  step: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "英小文字、数字、ハイフンだけを使えます"),
  prompt: z.string(),
  values: z.record(z.string(), z.string()),
  timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC),
  maxTurns: z.number().int().min(1),
});

/**
 * ワーカーに使わせないツール。
 *
 * 補助の守りである(シェルを経由すれば回避できる)。主たる守りは、資格情報を渡さないことと、
 * ネットワークを絞ることで、どちらもコンテナの側で行っている。
 */
export const DISALLOWED_TOOLS = [
  "Bash(gh *)",
  "Bash(git push *)",
  "Bash(curl *)",
  "Bash(wget *)",
] as const;

/**
 * ワーカーのコンテナの中で実行するコマンドを組み立てる純粋関数。
 * 指示書(値を差し込んだもの)は、引数ではなく標準入力で渡す。
 *
 * - `--setting-sources project`: プロジェクト設定だけを読む。ユーザー設定は読まない。
 * - `--strict-mcp-config`: `--mcp-config` を渡さないので、MCPは1つも読み込まれない。
 * - `--permission-mode bypassPermissions`: 承認に答える人がいないので、確認を挟まない。
 *   できることの範囲は、コンテナで守る。
 * - `--max-turns`: ヘルプには載っていないが、固定した版で効くことを確かめてある。
 * - `--bare` は使わない(サブスクリプションのトークンと `CLAUDE.md` を読まなくなる)。
 */
export function buildClaudeArgv(options: {
  maxTurns: number;
  statuses: readonly WorkerStatus[];
}): string[] {
  return [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(workerOutputJsonSchema(options.statuses)),
    "--max-turns",
    String(options.maxTurns),
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
  ];
}

export interface ClaudeWorkerDeps {
  /** 起動係に依頼する口。 */
  readonly launcher: WorkerLauncher;
  /** 指示書の置き場所。 */
  readonly promptsDir: string;
  /** ログの置き場所(設定の `logs_dir`)。 */
  readonly logsDir: string;
  readonly clock?: Clock;
}

/**
 * 起動係を通して、ワーカーのコンテナで `claude -p` を実行する実装。
 *
 * Claudeのトークンは、事務局は持たない。依頼で求めると、起動係がコンテナに渡す。
 * ワーカーに渡る環境変数は起動係が決め、依頼では指定できない。
 */
export function createClaudeWorker(deps: ClaudeWorkerDeps): WorkerInvoker {
  const clock = deps.clock ?? systemClock;
  return {
    async invoke(raw) {
      const parsed = WorkerCallSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `ワーカーの呼び出しの内容が不正です:\n${formatZodError(parsed.error)}`,
        );
      }
      const call = parsed.data;
      const logDir = stepLogDir(deps.logsDir, call.repo, call.issue);
      const instructions = renderPrompt(
        loadPrompt(deps.promptsDir, call.prompt),
        call.values,
      );

      const statuses = allowedStatuses(call.prompt);

      const request: RunRequestInput = {
        repo: call.repo,
        issue: call.issue,
        argv: buildClaudeArgv({ maxTurns: call.maxTurns, statuses }),
        stdin: instructions,
        claude_token: true,
        timeout_sec: call.timeoutSec,
      };

      const startedAt = clock.now();
      let run: RunResult | null = null;
      let outcome: WorkerOutcome;
      let interrupted = false;
      try {
        run = await deps.launcher.run(request);
        outcome = interpretRun(run, {
          timeoutSec: call.timeoutSec,
          statuses,
        });
      } catch (error) {
        // 止められた場合と、依頼を拒否された場合と、起動係に届かない場合。
        interrupted = error instanceof LauncherAbortedError;
        const message = error instanceof Error ? error.message : String(error);
        outcome = {
          status: "failed",
          summary: interrupted
            ? INTERRUPTED_SUMMARY
            : maskSecrets(`ワーカーを起動できませんでした: ${message}`),
          sessionId: null,
          costUsd: null,
          numTurns: null,
        };
      }
      const finishedAt = clock.now();

      // 標準入力(値を差し込んだ指示書)は、大きさだけを残す。
      const header = {
        repo: call.repo,
        issue: call.issue,
        step: call.step,
        prompt: call.prompt,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        timeout_sec: call.timeoutSec,
        max_turns: call.maxTurns,
        argv: request.argv,
        stdin_bytes: Buffer.byteLength(request.stdin ?? ""),
        exit_code: run?.exit_code ?? null,
        timed_out: run?.timed_out ?? null,
        truncated: run?.truncated ?? null,
        // 中断は、ワーカーの失敗と区別して残す。
        status: interrupted ? "interrupted" : outcome.status,
        summary: outcome.summary,
        session_id: outcome.sessionId,
        cost_usd: outcome.costUsd,
        num_turns: outcome.numTurns,
      };
      const text = [
        JSON.stringify(header, null, 2),
        "--- stdout ---",
        run?.stdout ?? "",
        "--- stderr ---",
        run?.stderr ?? "",
        "",
      ].join("\n");
      const logPath = writeStepLog({
        dir: logDir,
        startedAt,
        step: call.step,
        text,
      });
      return { ...outcome, logPath, interrupted };
    },
  };
}
