/**
 * 事務局の起動とメインループ。
 *
 * 起動時に設定を検証し、マイグレーションを実行してから、`poll_interval_sec` ごとに、
 * 同期と、実行の着手と進行(`supervisor.ts`)を行う。終わっていない実行は、起動後の最初の同期の後に再開する。
 *
 * SIGTERMとSIGINTを受けたら、実行中のポーリングを終え、進めている実行を止めてから終了する。
 * 実行中のステップは、終わるのを待たない(数時間かかることがある)。ステップを実行中のまま記録に残し、
 * 次の起動でそのステップからやり直す。ワーカーのコンテナは、依頼した事務局がいなくなると、起動係が止める。
 * 止めた実行は、試行に数えない。
 */
import { DEFAULT_PROMPTS_DIR } from "../agents/prompts.ts";
import { createClaudeWorker } from "../agents/worker.ts";
import { createLauncherClient } from "../launcher/client.ts";
import { systemClock } from "./clock.ts";
import {
  DEFAULT_CONFIG_PATH,
  type FactoryConfig,
  loadConfig,
  resolveToken,
} from "./config.ts";
import { migrate, openDb } from "./db.ts";
import { createGit } from "./git.ts";
import { createOctokitApi, type GitHubApi } from "./github.ts";
import { createRepoLocks } from "./locks.ts";
import { createLogger, errorFields, type Logger } from "./log.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";
import { type SyncDeps, syncAll } from "./sync.ts";
import { githubSourceUrl } from "./workspace.ts";

/** 起動係のUnixソケットの既定の場所。環境変数 LAUNCHER_SOCKET で変えられる。 */
const DEFAULT_LAUNCHER_SOCKET = "/run/launcher/launcher.sock";

/**
 * 終了のときに、進めている実行が止まるのを待つ時間。
 * コンテナの停止の猶予(Dockerの既定は10秒)より短くする。
 */
export const STOP_GRACE_MS = 8_000;

/**
 * `poll` を、止められるまで `intervalMs` おきに繰り返す。
 * 止める合図が来たら、実行中の `poll` を終えてから戻る。待機中ならすぐに戻る。
 */
export async function runLoop(options: {
  poll: () => Promise<void>;
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
}): Promise<void> {
  const { poll, intervalMs, signal, logger } = options;
  while (!signal.aborted) {
    try {
      await poll();
    } catch (error) {
      // 1回の失敗で常駐を止めない。次回のポーリングでやり直す。
      logger.error("poll.failed", errorFields(error));
    }
    await sleep(intervalMs, signal);
  }
}

/** `ms` ミリ秒待つ。`signal` が止められたら、そこで待つのをやめる。 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** リポジトリごとの通信の口を作る。トークンのない環境変数があれば、ここで失敗する。 */
export function createApis(
  config: FactoryConfig,
  env: Record<string, string | undefined>,
  logger: Logger,
): Map<string, GitHubApi> {
  const apis = new Map<string, GitHubApi>();
  for (const repo of config.repos) {
    apis.set(
      repo.repo,
      createOctokitApi({ token: resolveToken(repo, env), logger }),
    );
  }
  return apis;
}

/**
 * 1回のポーリング。同期してから、実行の着手と進行を行う。
 *
 * 実行を扱うのは、今回の同期に成功したリポジトリだけにする。同期できなかったリポジトリは、
 * DBの写しが古いかもしれないからである。1つのリポジトリの失敗は、ほかのリポジトリを止めない。
 */
export async function pollOnce(options: {
  sync: SyncDeps;
  supervisor: Pick<Supervisor, "tick">;
  /** 設定に書いた順のリポジトリ。 */
  repos: readonly string[];
  /** まだ全件の取り直しに成功していないリポジトリ。成功したものを、ここから除く。 */
  pendingFull: Set<string>;
}): Promise<void> {
  const results = await syncAll(options.sync, options.repos, {
    fullRepos: options.pendingFull,
  });
  for (const result of results) {
    if (result.ok) options.pendingFull.delete(result.repo);
  }
  await options.supervisor.tick(
    results.filter((result) => result.ok).map((result) => result.repo),
  );
}

/** 進めていた実行が、猶予の間にすべて止まったら true を返す。 */
async function main(): Promise<boolean> {
  const clock = systemClock;
  const logger = createLogger({ clock });

  const configPath = process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  const apis = createApis(config, process.env, logger);

  const db = openDb(config.db_path);
  try {
    const migration = migrate(db, { clock });
    logger.info("office.started", {
      config: configPath,
      dry_run: config.dry_run,
      poll_interval_sec: config.poll_interval_sec,
      repos: config.repos.map((repo) => repo.repo),
      migrations_applied: migration.applied,
      db_backup: migration.backupPath,
    });

    const controller = new AbortController();
    for (const name of ["SIGTERM", "SIGINT"] as const) {
      process.on(name, () => {
        logger.info("office.stopping", { signal: name });
        controller.abort();
      });
    }

    const repos = config.repos.map((repo) => repo.repo);
    const apiFor = (repo: string): GitHubApi => {
      const api = apis.get(repo);
      if (api === undefined) {
        throw new Error(`設定にないリポジトリです: ${repo}`);
      }
      return api;
    };
    const tokenFor = (repo: string): string => {
      const entry = config.repos.find((candidate) => candidate.repo === repo);
      if (entry === undefined) {
        throw new Error(`設定にないリポジトリです: ${repo}`);
      }
      return resolveToken(entry, process.env);
    };

    const locks = createRepoLocks();
    const launcher = createLauncherClient({
      socketPath: process.env.LAUNCHER_SOCKET ?? DEFAULT_LAUNCHER_SOCKET,
    });
    const supervisor = createSupervisor({
      runner: {
        db,
        clock,
        logger,
        git: createGit(),
        dirs: { reposDir: config.repos_dir, workDir: config.work_dir },
        logsDir: config.logs_dir,
        commitAuthor: config.commit_author,
        retryWaitMinutes: config.retry_wait_minutes,
        launcher,
        createWorker: (bound) =>
          createClaudeWorker({
            launcher: bound,
            promptsDir: DEFAULT_PROMPTS_DIR,
            logsDir: config.logs_dir,
            clock,
          }),
        // トークンは、gitの実行時にだけ渡す。
        sourceFor: (repo) => ({
          url: githubSourceUrl(repo),
          token: tokenFor(repo),
        }),
        writeFor: (repo) => ({
          api: apiFor(repo),
          dryRun: config.dry_run,
          logger,
        }),
      },
      locks,
      dailyRunLimit: config.daily_run_limit,
      dryRun: config.dry_run,
    });

    // 起動してから、まだ全件の取り直しに成功していないリポジトリ。
    const pendingFull = new Set(repos);

    await runLoop({
      intervalMs: config.poll_interval_sec * 1000,
      signal: controller.signal,
      logger,
      poll: () =>
        pollOnce({
          sync: { db, apiFor, dryRun: config.dry_run, clock, logger, locks },
          supervisor,
          repos,
          pendingFull,
        }),
    });

    // 進めている実行を止める。実行中のステップは記録に残り、次の起動でやり直す。
    const interrupted = supervisor.activeRunIds();
    const stopped = await supervisor.stop(STOP_GRACE_MS);
    logger.info("office.stopped", {
      runs_interrupted: interrupted,
      runs_stopped_in_time: stopped,
    });
    return stopped;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().then(
    (stopped) => {
      // 猶予の間に止まらなかった実行が残っていると、プロセスが終わらない。ここで終える。
      // 記録は実行中のまま残っているので、次の起動でやり直せる。
      if (!stopped) process.exit(0);
    },
    (error: unknown) => {
      createLogger().error("office.fatal", errorFields(error));
      process.exitCode = 1;
    },
  );
}
