/**
 * 起動係の本体。依頼を検査し、ワーカーのコンテナを立て、終わるまで待つ。
 *
 * 起動係はDockerソケットを持つので、受け付けるものを決まった形の依頼だけに絞る。
 * GitHubのトークンもDBも持たず、製品のコードもイシューの文章も読まない。
 */
import { z } from "zod";
import { type FactoryConfig, workerImageFor } from "../office/config.ts";
import { errorFields, type Logger } from "../office/log.ts";
import { parseRevision, REVISION_LABEL } from "../office/revision.ts";
import {
  buildRunArgs,
  CLAUDE_TOKEN_ENV,
  type ContainerSettings,
  workerLabel,
} from "./container.ts";
import type { Docker } from "./docker.ts";
import { checkDockerfile } from "./dockerfile.ts";
import {
  BUILD_ENV,
  BUILDER_PROBE_DOCKERFILE,
  buildBuildArgs,
  buildProbeArgs,
  builtImageFilters,
  builtImageName,
  IMAGE_DETAILS_FORMAT,
  isBuiltOn,
} from "./image.ts";
import {
  BUILD_TIMEOUT_SEC,
  type ImageBase,
  type ImageInfo,
  type ImagesReport,
  parseRunRequest,
  type RunResult,
} from "./request.ts";

/** `docker image inspect` で読む、イメージの情報。 */
const ImageDetailsSchema = z.object({
  id: z.string(),
  created: z.string(),
  labels: z.record(z.string(), z.string()).nullable(),
  layers: z.array(z.string()).nullable(),
});
type ImageDetails = z.infer<typeof ImageDetailsSchema>;

/** ワーカーの標準出力と標準エラーの、それぞれの上限。 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** イメージのビルドの標準出力と標準エラーの、それぞれの上限。 */
export const MAX_BUILD_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * 製品の Dockerfile から、実行に使うイメージを用意した結果。
 *
 * - `cached`: 同じ内容のイメージが手元にあった。
 * - `built`: ビルドした。
 * - `failed`: ビルドできなかった。`output` に、理由か、ビルドの出力が入る。
 */
type ImageOutcome =
  | { readonly status: "cached" | "built"; readonly image: string }
  | {
      readonly status: "failed";
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly output: string;
      readonly truncated: boolean;
    };

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
  /**
   * 設定にあるワーカーのイメージ(製品ごとに、実際に使うもの)が手元にあるかを確かめる。
   * なければログに出し、ないイメージの名前を返す。失敗させない
   * (イメージのある製品の実行を続けられるようにするため)。
   */
  checkImages(): Promise<string[]>;
  /**
   * 製品のイメージのビルドに使う旧ビルダーで、ワーカーのネットワークを指定できるかを試す。
   * 使えなければログに出し、false を返す。失敗させない(Dockerfile のない製品は動くため)。
   * 基本イメージが手元になくて試せない場合は、null を返す。
   */
  checkBuilder(): Promise<boolean | null>;
  /**
   * 起動係自身と、ワーカーのイメージ(設定にあるものと、起動係がビルドしたもの)が、
   * どの目印のものかを調べる。読むだけで、何も作らず、何も消さない。
   * 調べる対象は設定から決まり、依頼では選べない。
   */
  inspectImages(): Promise<ImagesReport>;
  /** 実行中のコンテナと、途中のビルドをすべて止める。 */
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
  /** 起動係自身のイメージの目印。目印のないイメージでは null。 */
  readonly revision?: string | null;
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
  /** 途中のビルド。同じ名前のイメージのビルドが重なったら、1つにまとめる。 */
  const builds = new Map<string, Promise<ImageOutcome>>();
  /** 途中のビルドを止める合図。 */
  const buildStops = new Set<AbortController>();

  const failedBuild = (output: string): ImageOutcome => ({
    status: "failed",
    exitCode: null,
    timedOut: false,
    output,
    truncated: false,
  });

  /** この製品の、`keep` のほかのビルド済みのイメージを消す。消せなくても、失敗させない。 */
  async function removeOldImages(repo: string, keep: string): Promise<void> {
    try {
      const listed = await docker.exec(
        [
          "image",
          "ls",
          ...builtImageFilters(settings, repo),
          "--format={{.Repository}}:{{.Tag}}",
        ],
        quiet,
      );
      if (listed.exitCode !== 0) {
        logger.warn("launcher.image_cleanup_failed", {
          repo,
          error: listed.stderr.trim(),
        });
        return;
      }
      const old = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name !== "" && name !== keep && !name.includes("<"));
      for (const image of old) {
        // 使用中のものは消せない。残して、次のビルドのときにまた試す。
        const removed = await docker.exec(["image", "rm", "--", image], quiet);
        if (removed.exitCode === 0) {
          logger.info("launcher.image_removed", { repo, image });
        } else {
          logger.warn("launcher.image_cleanup_failed", { repo, image });
        }
      }
    } catch (error) {
      logger.warn("launcher.image_cleanup_failed", {
        repo,
        ...errorFields(error),
      });
    }
  }

  /** `docker build` を実行する。時間の上限を過ぎたら止める。 */
  async function build(input: {
    repo: string;
    baseImage: string;
    image: string;
    dockerfile: string;
  }): Promise<ImageOutcome> {
    const { repo, image } = input;
    const args = buildBuildArgs({
      settings,
      repo,
      baseImage: input.baseImage,
      image,
    });
    // Dockerfile の本文と、ビルドの出力は記録しない(製品の内容が入りうる)。
    logger.info("launcher.build_started", {
      repo,
      image,
      timeout_sec: BUILD_TIMEOUT_SEC,
    });
    const startedAt = Date.now();
    const stop = new AbortController();
    buildStops.add(stop);
    let timedOut = false;
    const cancelTimer = setTimer(() => {
      timedOut = true;
      stop.abort();
    }, BUILD_TIMEOUT_SEC * 1000);
    try {
      const result = await docker.exec(args, {
        stdin: input.dockerfile,
        // Claudeのトークンは、ここには入れない。
        env: { ...dockerEnv, ...BUILD_ENV },
        maxOutputBytes: MAX_BUILD_OUTPUT_BYTES,
        signal: stop.signal,
      });
      const ok = result.exitCode === 0 && !timedOut && !stop.signal.aborted;
      logger[ok ? "info" : "warn"]("launcher.build_finished", {
        repo,
        image,
        exit_code: result.exitCode,
        timed_out: timedOut,
        truncated: result.truncated,
        duration_ms: Date.now() - startedAt,
      });
      if (!ok) {
        return {
          status: "failed",
          exitCode: result.exitCode,
          timedOut,
          output: [
            timedOut
              ? `イメージのビルドが、時間の上限(${BUILD_TIMEOUT_SEC}秒)を過ぎました`
              : "イメージのビルドに失敗しました",
            result.stdout,
            result.stderr,
          ].join("\n"),
          truncated: result.truncated,
        };
      }
      await removeOldImages(repo, image);
      return { status: "built", image };
    } catch (error) {
      logger.error("launcher.build_failed", { repo, ...errorFields(error) });
      return failedBuild(
        `イメージのビルドを始められませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      cancelTimer();
      buildStops.delete(stop);
    }
  }

  /**
   * 製品の Dockerfile から、実行に使うイメージを用意する。
   * 名前は内容から決まるので、同じ内容なら、ビルドは1回だけになる。
   */
  async function ensureImage(input: {
    repo: string;
    baseImage: string;
    dockerfile: string;
  }): Promise<ImageOutcome> {
    const { repo, baseImage, dockerfile } = input;
    const checked = checkDockerfile(dockerfile);
    if (!checked.ok) {
      logger.warn("launcher.build_rejected", { repo, reason: checked.reason });
      return failedBuild(checked.reason);
    }
    try {
      const base = await docker.exec(
        ["image", "inspect", "--format={{.Id}}", "--", baseImage],
        quiet,
      );
      const baseImageId = base.stdout.trim();
      if (base.exitCode !== 0 || baseImageId === "") {
        logger.warn("launcher.image_missing", {
          image: baseImage,
          repos: [repo],
        });
        return failedBuild(
          `基本イメージが手元にありません: ${baseImage}(docker compose build worker-image で作ります)`,
        );
      }
      const image = builtImageName({ settings, repo, baseImageId, dockerfile });
      const existing = await docker.exec(
        ["image", "inspect", "--format={{.Id}}", "--", image],
        quiet,
      );
      if (existing.exitCode === 0) return { status: "cached", image };

      const inFlight = builds.get(image);
      if (inFlight !== undefined) return await inFlight;
      const started = build({ repo, baseImage, image, dockerfile }).finally(
        () => {
          builds.delete(image);
        },
      );
      builds.set(image, started);
      return await started;
    } catch (error) {
      logger.error("launcher.build_failed", { repo, ...errorFields(error) });
      return failedBuild(
        `イメージを用意できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** イメージの情報を読む。手元になければ null。読めない応答は、原因の分かるメッセージで失敗させる。 */
  async function readImage(image: string): Promise<ImageDetails | null> {
    const result = await docker.exec(
      ["image", "inspect", `--format=${IMAGE_DETAILS_FORMAT}`, "--", image],
      quiet,
    );
    if (result.exitCode !== 0) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`イメージの情報をJSONとして読めません: ${image}`, {
        cause: error,
      });
    }
    const parsed = ImageDetailsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`イメージの情報の形式が不正です: ${image}`);
    }
    return parsed.data;
  }

  /** イメージの情報を、応答の1件にする。 */
  function imageInfo(input: {
    kind: ImageInfo["kind"];
    image: string;
    repos: string[];
    details: ImageDetails | null;
    /** 土台にしているはずの基本。`self` は、このイメージが基本そのものであること。 */
    base: ImageDetails | null | "self";
  }): ImageInfo {
    const { kind, image, repos, details, base } = input;
    let relation: ImageBase;
    if (base === "self") {
      relation = "self";
    } else if (details === null || base === null) {
      relation = "unknown";
    } else {
      relation = isBuiltOn(details.layers ?? [], base.layers ?? [])
        ? "current"
        : "stale";
    }
    const created = details === null ? Number.NaN : Date.parse(details.created);
    return {
      kind,
      image,
      repos,
      present: details !== null,
      created: Number.isNaN(created) ? null : new Date(created).toISOString(),
      // ラベルは、イメージを作った者が自由に書ける。目印の形のものだけを返す。
      revision: parseRevision(details?.labels?.[REVISION_LABEL]),
      base: relation,
    };
  }

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

      // イメージは、設定から決まる。製品の Dockerfile が添えられていれば、設定のイメージを
      // 土台にしてビルドしたものを使う。どちらの場合も、名前は依頼では選べない。
      let image = workerImageFor(config, entry.repo);
      let buildStatus: "cached" | "built" | undefined;
      if (request.dockerfile !== undefined) {
        const outcome = await ensureImage({
          repo: entry.repo,
          baseImage: image,
          dockerfile: request.dockerfile,
        });
        if (outcome.status === "failed") {
          // コマンドは実行しない。ビルドの失敗として、結果を返す。
          return {
            ok: true,
            result: {
              exit_code: outcome.exitCode,
              timed_out: outcome.timedOut,
              stdout: "",
              stderr: outcome.output,
              truncated: outcome.truncated,
              build: "failed",
            },
          };
        }
        image = outcome.image;
        buildStatus = outcome.status;
        if (signal?.aborted) {
          logger.warn("launcher.run_abandoned", {
            repo: entry.repo,
            workspace: request.workspace,
            issue: request.issue ?? null,
          });
          return { ok: false, error: "依頼した側がいなくなりました" };
        }
      }

      const containerName = deps.newContainerName();
      let args: string[];
      try {
        args = buildRunArgs({
          request,
          // パスには、依頼の書き方ではなく、設定の書き方を使う。
          repo: entry.repo,
          image,
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
        workspace: request.workspace,
        issue: request.issue ?? null,
        container: containerName,
        claude_token: request.claude_token,
        ...(buildStatus === undefined ? {} : { build: buildStatus }),
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
            ...(buildStatus === undefined ? {} : { build: buildStatus }),
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
        ["ps", "--all", "--quiet", `--filter=label=${workerLabel(settings)}`],
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

    async checkImages() {
      // イメージごとに、それを使う製品をまとめる。同じイメージは1回だけ確かめる。
      const users = new Map<string, string[]>();
      for (const entry of config.repos) {
        const image = workerImageFor(config, entry.repo);
        users.set(image, [...(users.get(image) ?? []), entry.repo]);
      }
      const missing: string[] = [];
      for (const [image, repos] of users) {
        try {
          // 起動係はイメージを外から取ってこないので、手元になければワーカーを立てられない。
          const result = await docker.exec(
            ["image", "inspect", "--format={{.Id}}", "--", image],
            quiet,
          );
          if (result.exitCode === 0) continue;
          missing.push(image);
          logger.warn("launcher.image_missing", { image, repos });
        } catch (error) {
          logger.error("launcher.image_check_failed", {
            image,
            repos,
            ...errorFields(error),
          });
        }
      }
      return missing;
    },

    async checkBuilder() {
      const baseImage = config.worker_image;
      try {
        const base = await docker.exec(
          ["image", "inspect", "--format={{.Id}}", "--", baseImage],
          quiet,
        );
        // 基本イメージがなければ、試せない(ないことは、checkImages がログに出す)。
        if (base.exitCode !== 0) return null;
        const result = await docker.exec(
          buildProbeArgs({ settings, baseImage }),
          {
            stdin: BUILDER_PROBE_DOCKERFILE,
            env: { ...dockerEnv, ...BUILD_ENV },
            maxOutputBytes: 64 * 1024,
          },
        );
        if (result.exitCode === 0) return true;
        logger.warn("launcher.builder_unavailable", {
          network: settings.network,
          exit_code: result.exitCode,
          error: result.stderr.trim().slice(-2000),
        });
        return false;
      } catch (error) {
        logger.error("launcher.builder_check_failed", errorFields(error));
        return false;
      }
    },

    async inspectImages() {
      // 同じイメージは、1回だけ読む。
      const cache = new Map<string, Promise<ImageDetails | null>>();
      const read = (image: string) => {
        const known = cache.get(image);
        if (known !== undefined) return known;
        const started = readImage(image);
        cache.set(image, started);
        return started;
      };

      const baseImage = config.worker_image;
      const users = new Map<string, string[]>();
      for (const entry of config.repos) {
        const image = workerImageFor(config, entry.repo);
        users.set(image, [...(users.get(image) ?? []), entry.repo]);
      }
      const images: ImageInfo[] = [];
      for (const [image, repos] of users) {
        images.push(
          imageInfo({
            kind: "configured",
            image,
            repos,
            details: await read(image),
            // 製品ごとのイメージ(手でビルドしたもの)は、全体の基本を土台にしているはずである。
            base: image === baseImage ? "self" : await read(baseImage),
          }),
        );
      }
      for (const entry of config.repos) {
        const listed = await docker.exec(
          [
            "image",
            "ls",
            ...builtImageFilters(settings, entry.repo),
            "--format={{.Repository}}:{{.Tag}}",
          ],
          quiet,
        );
        if (listed.exitCode !== 0) {
          throw new Error(
            `ビルドしたイメージを一覧できません: ${listed.stderr.trim()}`,
          );
        }
        const built = listed.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((name) => name !== "" && !name.includes("<"))
          .sort();
        for (const image of built) {
          images.push(
            imageInfo({
              kind: "built",
              image,
              repos: [entry.repo],
              details: await read(image),
              // ビルドの土台は、その製品の、設定のイメージである。
              base: await read(workerImageFor(config, entry.repo)),
            }),
          );
        }
      }
      return { revision: deps.revision ?? null, base_image: baseImage, images };
    },

    async stopAll() {
      for (const stop of buildStops) stop.abort();
      await Promise.all([...running].map((name) => kill(name)));
    },
  };
}
