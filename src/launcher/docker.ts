/**
 * `docker` コマンドの実行。テストで差し替えられるように、インターフェース越しに注入する。
 */
import { spawn } from "node:child_process";

export interface CommandResult {
  /** 終了コード。シグナルで終わった場合は null。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 出力が上限を超えて、途中で切られた場合は true。 */
  readonly truncated: boolean;
}

export interface CommandOptions {
  /** 標準入力に渡す文字列。 */
  readonly stdin?: string;
  /** 子プロセスに渡す環境変数。ここにあるものだけが渡る。 */
  readonly env: Record<string, string>;
  /** 標準出力と標準エラーの、それぞれの上限。 */
  readonly maxOutputBytes: number;
}

export interface Docker {
  /** `docker <args>` を実行し、終わるまで待つ。 */
  exec(
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult>;
}

/** 上限までためる入れ物。上限を超えた分は捨てる。 */
function collector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      const room = maxBytes - size;
      if (chunk.length <= room) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      if (room > 0) {
        chunks.push(chunk.subarray(0, room));
        size += room;
      }
      truncated = true;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

/** 実際にコマンドを起動する実装。`command` の既定は `docker`。 */
export function createDockerCli(command = "docker"): Docker {
  return {
    exec(args, options) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = collector(options.maxOutputBytes);
        const stderr = collector(options.maxOutputBytes);
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error) => {
          reject(new Error(`${command} を起動できません`, { cause: error }));
        });
        child.on("close", (code) => {
          resolve({
            exitCode: code,
            stdout: stdout.text(),
            stderr: stderr.text(),
            truncated: stdout.truncated() || stderr.truncated(),
          });
        });
        // 相手が読まずに終わっても、こちらは落ちない。
        child.stdin.on("error", () => {});
        child.stdin.end(options.stdin ?? "");
      });
    },
  };
}
