/**
 * 事務局の起動とメインループ。
 *
 * 起動時に設定を検証し、マイグレーションを実行してから、`poll_interval_sec` ごとに同期する。
 * SIGTERMとSIGINTを受けたら、実行中のポーリングを終えてから終了する。
 */
import { systemClock } from "./clock.ts";
import {
  DEFAULT_CONFIG_PATH,
  type FactoryConfig,
  loadConfig,
  resolveToken,
} from "./config.ts";
import { migrate, openDb } from "./db.ts";
import { createOctokitApi, type GitHubApi } from "./github.ts";
import { createLogger, errorFields, type Logger } from "./log.ts";
import { syncAll } from "./sync.ts";

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

async function main(): Promise<void> {
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

    // 起動してから、まだ全件の取り直しに成功していないリポジトリ。
    const pendingFull = new Set(config.repos.map((repo) => repo.repo));

    await runLoop({
      intervalMs: config.poll_interval_sec * 1000,
      signal: controller.signal,
      logger,
      poll: async () => {
        const results = await syncAll(
          {
            db,
            apiFor: (repo) => {
              const api = apis.get(repo);
              if (api === undefined) {
                throw new Error(`設定にないリポジトリです: ${repo}`);
              }
              return api;
            },
            dryRun: config.dry_run,
            clock,
            logger,
          },
          config.repos.map((repo) => repo.repo),
          { fullRepos: pendingFull },
        );
        for (const result of results) {
          if (result.ok) pendingFull.delete(result.repo);
        }
      },
    });
    logger.info("office.stopped");
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("office.fatal", errorFields(error));
    process.exitCode = 1;
  });
}
