/**
 * 起動係の本体。依頼を検査し、ワーカーのコンテナを立て、終わるまで待つ。
 *
 * 起動係はDockerソケットを持つので、受け付けるものを決まった形の依頼だけに絞る。
 * GitHubのトークンもDBも持たず、製品のコードもイシューの文章も読まない。
 */
import { type FactoryConfig, workerImageFor } from "../office/config.ts";
import { errorFields, type Logger } from "../office/log.ts";
import {
  buildRunArgs,
  CLAUDE_TOKEN_ENV,
  type ContainerSettings,
  WORKER_LABEL,
} from "./container.ts";
import type { Docker } from "./docker.ts";
import { parseRunRequest, type RunResult } from "./request.ts";

/** ワーカーの標準出力と標準エラーの、それぞれの上限。 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type LauncherResponse =
  | { readonly ok: true; readonly result: RunResult }
  | { readonly ok: false; readonly error: string };

export interface Launcher {
  /**
   * 依頼を1件実行する。`signal` が止められたら(依頼した側がいなくなったら)、
   * コンテナを止める。
   */
  run(raw: unknown, signal?: AbortSignal): Promise<LauncherResponse>;
  /** 前回の起動で残ったワーカーのコンテナを消す。消した数を返す。 */
  removeLeftovers(): Promise<number>;
  /** 実行中のコンテナをすべて止める。 */
  stopAll(): Promise<void>;
}

export interface LauncherDeps {
  readonly config: FactoryConfig;
  readonly settings: ContainerSettings;
  readonly docker: Docker;
  /** Claudeのトークン。なければ、トークンを求める依頼は失敗する。 */
  readonly claudeToken: string | undefined;
  /** `docker` コマンド自体に渡す環境変数(PATHなど)。 */
  readonly dockerEnv: Record<string, string>;
  readonly logger: Logger;
  /** コンテナの名前を作る。重ならないこと。 */
  readonly newContainerName: () => string;
  /** 時間の上限の計り方。テストで差し替えられる。 */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
  /** コンテナを止められなかったときに、次に試すまでの間隔。 */
  readonly killRetryMs?: number;
}

/** コンテナを止めるのを試す回数。 */
const KILL_ATTEMPTS = 5;

export function createLauncher(deps: LauncherDeps): Launcher {
  const { config, settings, docker, claudeToken, dockerEnv, logger } = deps;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const killRetryMs = deps.killRetryMs ?? 1000;
  const running = new Set<string>();
  const quiet = { env: dockerEnv, maxOutputBytes: 64 * 1024 };

  /**
   * コンテナを止める。まだ立ち上がっていない間は止められないので、
   * 実行が続いている限り、間を置いて何度か試す。
   */
  async function kill(name: string): Promise<void> {
    for (let attempt = 0; attempt < KILL_ATTEMPTS; attempt += 1) {
      try {
        const result = await docker.exec(["kill", name], quiet);
        if (result.exitCode === 0) return;
      } catch (error) {
        logger.error("launcher.kill_failed", {
          container: name,
          ...errorFields(error),
        });
        return;
      }
      // すでに終わっていれば、止めるものはない。
      if (!running.has(name)) return;
      await new Promise<void>((resolve) => {
        setTimer(resolve, killRetryMs);
      });
    }
    logger.error("launcher.kill_failed", {
      container: name,
      error: "止められませんでした",
    });
  }

  return {
    async run(raw, signal) {
      const parsed = parseRunRequest(raw);
      if (!parsed.ok) {
        logger.warn("launcher.rejected", { reason: "bad_request" });
        return { ok: false, error: parsed.error };
      }
      const request = parsed.value;

      const entry = config.repos.find(
        (candidate) =>
          candidate.repo.toLowerCase() === request.repo.toLowerCase(),
      );
      if (entry === undefined) {
        logger.warn("launcher.rejected", {
          reason: "unknown_repo",
          repo: request.repo,
        });
        return {
          ok: false,
          error: `設定にないリポジトリです: ${request.repo}`,
        };
      }
      if (request.claude_token && claudeToken === undefined) {
        logger.error("launcher.rejected", { reason: "no_claude_token" });
        return {
          ok: false,
          error: `起動係に ${CLAUDE_TOKEN_ENV} が設定されていません`,
        };
      }

      const containerName = deps.newContainerName();
      let args: string[];
      try {
        args = buildRunArgs({
          request,
          // パスには、依頼の書き方ではなく、設定の書き方を使う。
          repo: entry.repo,
          image: workerImageFor(config, entry.repo),
          containerName,
          settings,
        });
      } catch (error) {
        logger.warn("launcher.rejected", {
          reason: "bad_container",
          ...errorFields(error),
        });
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // 引数、標準入力、出力は記録しない(製品のコードやイシューの文章が入りうる)。
      const fields = {
        repo: entry.repo,
        issue: request.issue,
        container: containerName,
        claude_token: request.claude_token,
      };
      logger.info("launcher.run_started", {
        ...fields,
        timeout_sec: request.timeout_sec,
      });
      const startedAt = Date.now();

      let timedOut = false;
      const cancelTimer = setTimer(() => {
        timedOut = true;
        void kill(containerName);
      }, request.timeout_sec * 1000);
      const onAbort = () => {
        logger.warn("launcher.run_abandoned", fields);
        void kill(containerName);
      };
      signal?.addEventListener("abort", onAbort);
      running.add(containerName);

      try {
        const env = { ...dockerEnv };
        // トークンは、求められたときだけ、docker の環境変数を通して渡す。
        if (request.claude_token && claudeToken !== undefined) {
          env[CLAUDE_TOKEN_ENV] = claudeToken;
        }
        const result = await docker.exec(args, {
          stdin: request.stdin,
          env,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        });
        logger.info("launcher.run_finished", {
          ...fields,
          exit_code: result.exitCode,
          timed_out: timedOut,
          truncated: result.truncated,
          duration_ms: Date.now() - startedAt,
        });
        return {
          ok: true,
          result: {
            exit_code: result.exitCode,
            timed_out: timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        logger.error("launcher.run_failed", {
          ...fields,
          ...errorFields(error),
        });
        // 起動の途中で失敗した場合に、コンテナを残さない。
        running.delete(containerName);
        await kill(containerName);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        cancelTimer();
        signal?.removeEventListener("abort", onAbort);
        running.delete(containerName);
      }
    },

    async removeLeftovers() {
      const listed = await docker.exec(
        ["ps", "--all", "--quiet", `--filter=label=${WORKER_LABEL}=1`],
        quiet,
      );
      if (listed.exitCode !== 0) {
        throw new Error(
          `ワーカーのコンテナを一覧できません: ${listed.stderr.trim()}`,
        );
      }
      const ids = listed.stdout.split("\n").filter((id) => id.trim() !== "");
      if (ids.length === 0) return 0;
      const removed = await docker.exec(["rm", "--force", ...ids], quiet);
      if (removed.exitCode !== 0) {
        throw new Error(
          `残っていたワーカーのコンテナを消せません: ${removed.stderr.trim()}`,
        );
      }
      logger.warn("launcher.leftovers_removed", { count: ids.length });
      return ids.length;
    },

    async stopAll() {
      await Promise.all([...running].map((name) => kill(name)));
    },
  };
}
