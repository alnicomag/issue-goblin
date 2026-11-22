/**
 * 事務局が実行するgit。
 *
 * 事務局は、ワーカーが書き換えられるリポジトリ(作業場所のclone)でもgitを実行する。
 * そこに仕込まれたフックや設定で、事務局の権限のままコマンドが動かないように、
 * gitの呼び出しをここに集め、毎回同じ守りを付ける。
 *
 * - フックを無効にする(`core.hooksPath`)。リポジトリ側の設定より、ここでの指定が優先される。
 * - 設定から外部のコマンドを起動する項目(`core.fsmonitor`、資格情報ヘルパー)を空にする。
 * - 事務局のプロセスの環境変数を引き継がない。GitHubのトークンが、gitやその子プロセスに渡らない。
 * - システムとユーザーのgit設定を読まない。
 */
import { execFile } from "node:child_process";

/** 取得元との通信に使う資格情報。`url` で始まる宛先にだけ送る。 */
export interface GitAuth {
  readonly url: string;
  readonly token: string;
}

export interface GitRunOptions {
  /** 実行する場所。 */
  readonly cwd?: string;
  /** 取得元との通信に使う資格情報。実行のときにだけ渡し、gitの設定やURLには残さない。 */
  readonly auth?: GitAuth;
}

/** gitの実行。テストで差し替えられるように、インターフェース越しに注入する。 */
export interface Git {
  /** gitを実行して、標準出力を返す。終了コードが0でなければ失敗する。 */
  run(args: readonly string[], options?: GitRunOptions): Promise<string>;
}

/** どの呼び出しにも付ける設定。リポジトリ側の設定より優先される。 */
export const SAFE_GIT_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "credential.helper=",
];

/** 実際に起動するときの引数と環境変数。 */
export interface GitInvocation {
  readonly args: string[];
  readonly env: Record<string, string>;
}

/**
 * gitの引数と環境変数を組み立てる純粋関数。
 *
 * トークンは環境変数(`GIT_CONFIG_*`)で渡す。引数に入れると、プロセスの一覧から見えるためである。
 * HTTPSでない取得元(手元のパスなど)には、トークンを渡さない。
 */
export function gitInvocation(
  args: readonly string[],
  options: GitRunOptions = {},
  searchPath = "/usr/local/bin:/usr/bin:/bin",
): GitInvocation {
  const env: Record<string, string> = {
    PATH: searchPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const { auth } = options;
  if (auth?.url.startsWith("https://")) {
    if (/[\r\n]/.test(auth.token)) {
      throw new Error("トークンに改行が含まれています");
    }
    const basic = Buffer.from(`x-access-token:${auth.token}`).toString(
      "base64",
    );
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${auth.url}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return {
    args: [...SAFE_GIT_CONFIG.flatMap((entry) => ["-c", entry]), ...args],
    env,
  };
}

/** 本物のgitを起動する実装。 */
export function createGit(
  options: { timeoutMs?: number; searchPath?: string } = {},
): Git {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const searchPath = options.searchPath ?? process.env.PATH;
  return {
    run(args, runOptions = {}) {
      const invocation = gitInvocation(args, runOptions, searchPath);
      return new Promise((resolve, reject) => {
        execFile(
          "git",
          invocation.args,
          {
            cwd: runOptions.cwd,
            env: invocation.env,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve(stdout);
              return;
            }
            // 引数にトークンは入らないので、そのままメッセージに出してよい。
            reject(
              new Error(
                `git ${args.join(" ")} に失敗しました${
                  runOptions.cwd === undefined ? "" : `(${runOptions.cwd})`
                }: ${stderr.trim() || error.message}`,
                { cause: error },
              ),
            );
          },
        );
      });
    },
  };
}
