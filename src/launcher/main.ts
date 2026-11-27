/**
 * 起動係の起動。
 *
 * Dockerソケットを持つコンテナで動かす。ネットワークにはつながない。
 * 設定は、ファクトリー側の設定ファイル(リポジトリとイメージの一覧)と、環境変数から読む。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import {
  DEFAULT_CONFIG_PATH,
  formatZodError,
  loadConfig,
} from "../office/config.ts";
import { createLogger, errorFields } from "../office/log.ts";
import { revisionFromEnv } from "../office/revision.ts";
import { CLAUDE_TOKEN_ENV, type ContainerSettings } from "./container.ts";
import { createDockerCli } from "./docker.ts";
import { createLauncher } from "./launcher.ts";
import { createLauncherServer } from "./server.ts";

export const DEFAULT_SOCKET_PATH = "/run/launcher/launcher.sock";

/** Dockerの名前(ボリューム、ネットワーク)。オプションに見える書き方を通さない。 */
const DockerName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Dockerの名前として使えません");

const EnvSchema = z.object({
  WORK_VOLUME: DockerName,
  WORKER_NETWORK: DockerName,
  WORKER_PROXY_URL: z
    .string()
    .regex(
      /^http:\/\/[A-Za-z0-9.-]+:\d{1,5}$/,
      "http://host:port の形式で書いてください",
    ),
  WORKER_USER: z
    .string()
    .regex(/^\d+:\d+$/, "uid:gid の形式で書いてください")
    .default("1000:1000"),
  WORKER_MEMORY: z
    .string()
    .regex(/^\d+[kmg]$/, "2g のように書いてください")
    .default("2g"),
  WORKER_PIDS_LIMIT: z.coerce.number().int().min(16).default(512),
  WORKER_CPUS: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "2 や 1.5 のように書いてください")
    .default("2"),
  WORKER_TMP_SIZE: z
    .string()
    .regex(/^\d+[kmg]$/, "1g のように書いてください")
    .default("1g"),
});

/** 環境変数から、ワーカーのコンテナの設定を読む。 */
export function settingsFromEnv(
  env: Record<string, string | undefined>,
): ContainerSettings {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `起動係の環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }
  const value = result.data;
  return {
    workVolume: value.WORK_VOLUME,
    network: value.WORKER_NETWORK,
    proxyUrl: value.WORKER_PROXY_URL,
    user: value.WORKER_USER,
    memory: value.WORKER_MEMORY,
    pidsLimit: value.WORKER_PIDS_LIMIT,
    cpus: value.WORKER_CPUS,
    tmpSize: value.WORKER_TMP_SIZE,
  };
}

/** `docker` コマンドに渡す環境変数。起動係の環境をそのまま引き継がせない。 */
export function dockerEnvFrom(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["PATH", "DOCKER_HOST"]) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  // docker が設定ファイルを探しにいく場所を、書き込めない場所にしておく。
  result.HOME = "/nonexistent";
  return result;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const settings = settingsFromEnv(process.env);
  const socketPath = process.env.LAUNCHER_SOCKET ?? DEFAULT_SOCKET_PATH;
  const token = process.env[CLAUDE_TOKEN_ENV]?.trim();

  const launcher = createLauncher({
    config,
    settings,
    docker: createDockerCli(),
    claudeToken: token === undefined || token === "" ? undefined : token,
    dockerEnv: dockerEnvFrom(process.env),
    logger,
    newContainerName: () => `factory-worker-${randomBytes(8).toString("hex")}`,
  });

  // 前回の起動で残ったコンテナを消してから、依頼を受け始める。
  // Dockerに届くことの確認も兼ねる。
  try {
    await launcher.removeLeftovers();
  } catch (error) {
    throw new Error(
      "Dockerを使えません。.env の DOCKER_GID が、ホストの docker グループの番号と合っているかを確かめてください",
      { cause: error },
    );
  }

  // 設定にあるイメージが手元にあるかを確かめる。なければログに出すだけで、止まらない。
  // ビルドで付けた名前(WORKER_IMAGE)と、設定の worker_image の食い違いに、着手の前に気づける。
  await launcher.checkImages();
  // 製品のイメージのビルドに使う旧ビルダーが、使えるかを試す。使えなければログに出すだけで、止まらない。
  // Docker を上げて旧ビルダーがなくなったことに、着手の前に気づける。
  await launcher.checkBuilder();

  // 前回のソケットが残っていると、待ち受けに失敗する。
  fs.rmSync(socketPath, { force: true });
  const server = createLauncherServer({ launcher, logger });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      // 事務局(同じuid)だけが依頼できるようにする。
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  logger.info("launcher.started", {
    revision: revisionFromEnv(process.env),
    socket: socketPath,
    repos: config.repos.map((repo) => repo.repo),
    network: settings.network,
    work_volume: settings.workVolume,
    claude_token: token !== undefined && token !== "",
  });

  let stopping = false;
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.on(name, () => {
      if (stopping) return;
      stopping = true;
      logger.info("launcher.stopping", { signal: name });
      server.close();
      launcher
        .stopAll()
        .catch((error: unknown) => {
          logger.error("launcher.stop_failed", errorFields(error));
        })
        .finally(() => {
          server.closeAllConnections();
          fs.rmSync(socketPath, { force: true });
        });
    });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    createLogger().error("launcher.fatal", errorFields(error));
    process.exitCode = 1;
  });
}
