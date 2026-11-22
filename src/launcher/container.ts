/**
 * ワーカーのコンテナの形。`docker run` の引数を組み立てる純粋関数。
 *
 * ワーカーから見えるものは、ここで決まる。依頼から来る値が入るのは、
 * 作業場所のパス(リポジトリとイシュー番号から組み立てる)と、実行するコマンドだけである。
 */
import path from "node:path";
import type { RunRequest } from "./request.ts";

/**
 * ワーカーのコンテナに付ける目印の名前。残ったコンテナの片付けに使う。
 * 値は作業場所のボリュームの名前にして、同じホストの別のファクトリーのものと区別する。
 */
export const WORKER_LABEL = "factory.worker";

/** この起動係が立てたコンテナを表す目印(`名前=値`)。 */
export function workerLabel(settings: ContainerSettings): string {
  return `${WORKER_LABEL}=${settings.workVolume}`;
}

/** コンテナの中での、作業場所のマウント先。 */
export const WORKSPACE_MOUNT = "/workspace";
/** コンテナの中での、製品のcloneの場所。 */
export const WORKSPACE_REPO = `${WORKSPACE_MOUNT}/repo`;
/** コンテナの中での、ワーカーのHOME。 */
export const WORKSPACE_HOME = `${WORKSPACE_MOUNT}/home`;

/** Claudeのトークンを入れる環境変数の名前。 */
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** 起動係の設定。依頼では変えられない。 */
export interface ContainerSettings {
  /** 作業場所のボリュームの名前。 */
  readonly workVolume: string;
  /** ワーカーをつなぐネットワークの名前(外への経路がないもの)。 */
  readonly network: string;
  /** プロキシのURL。 */
  readonly proxyUrl: string;
  /** ワーカーを動かすユーザー(uid:gid)。事務局の実行ユーザーと同じにする。 */
  readonly user: string;
  readonly memory: string;
  readonly pidsLimit: number;
  readonly cpus: string;
  /** `/tmp` の大きさ。 */
  readonly tmpSize: string;
}

/**
 * 作業場所の、ボリュームの中での相対パス(`<owner>/<name>/issue-<番号>`)。
 *
 * `repo` は設定にある書き方をそのまま渡すこと。`.` や `..` を含むなど、
 * 置き場所の外に出るパスになる場合は失敗する。
 */
export function issueDirFor(repo: string, issue: number): string {
  const segments = repo.split("/");
  const [owner, name] = segments;
  if (
    segments.length !== 2 ||
    owner === undefined ||
    name === undefined ||
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(name) ||
    [".", ".."].includes(owner) ||
    [".", ".."].includes(name)
  ) {
    throw new Error(`リポジトリ名から作業場所を決められません: ${repo}`);
  }
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new Error(`イシュー番号が不正です: ${issue}`);
  }
  const relative = path.posix.join(owner, name, `issue-${issue}`);
  // 念のため、組み立てた結果でも確かめる。
  if (
    path.posix.isAbsolute(relative) ||
    relative.split("/").length !== 3 ||
    relative.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error(`作業場所が置き場所の外に出ます: ${relative}`);
  }
  return relative;
}

/**
 * ワーカーのコンテナに渡す環境変数。ここにあるものだけが渡る。
 * 値のないもの(名前だけ)は、起動係のプロセスから引き継ぐ。
 */
export function workerEnv(
  settings: ContainerSettings,
  options: { claudeToken: boolean },
): string[] {
  const env = [
    `HOME=${WORKSPACE_HOME}`,
    `HTTPS_PROXY=${settings.proxyUrl}`,
    `HTTP_PROXY=${settings.proxyUrl}`,
    `https_proxy=${settings.proxyUrl}`,
    `http_proxy=${settings.proxyUrl}`,
  ];
  if (options.claudeToken) env.push(CLAUDE_TOKEN_ENV);
  return env;
}

/** `docker run` に渡す引数(`docker` 自体は含まない)。 */
export function buildRunArgs(input: {
  request: RunRequest;
  /** 設定にある書き方のリポジトリ名。 */
  repo: string;
  image: string;
  containerName: string;
  settings: ContainerSettings;
}): string[] {
  const { request, repo, image, containerName, settings } = input;
  const subpath = issueDirFor(repo, request.issue);
  if (image.startsWith("-") || image === "") {
    throw new Error(`イメージ名が不正です: ${image}`);
  }

  const args = [
    "run",
    "--rm",
    "--interactive",
    "--init",
    "--pull=never",
    `--name=${containerName}`,
    `--label=${workerLabel(settings)}`,
    `--network=${settings.network}`,
    `--user=${settings.user}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    `--tmpfs=/tmp:rw,exec,nosuid,size=${settings.tmpSize}`,
    `--memory=${settings.memory}`,
    `--pids-limit=${settings.pidsLimit}`,
    `--cpus=${settings.cpus}`,
    `--mount=type=volume,src=${settings.workVolume},dst=${WORKSPACE_MOUNT},volume-subpath=${subpath}`,
    `--workdir=${WORKSPACE_REPO}`,
  ];
  for (const entry of workerEnv(settings, {
    claudeToken: request.claude_token,
  })) {
    args.push(`--env=${entry}`);
  }
  // `--` の後ろは、すべてコンテナの中で実行するコマンドになる。
  args.push("--", image, ...request.argv);
  return args;
}
