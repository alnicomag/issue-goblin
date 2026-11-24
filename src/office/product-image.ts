/**
 * 製品の Dockerfile を、起動係への依頼に添える。
 *
 * `factory.yml` に `worker.dockerfile` を書いた製品では、ワーカー、verify、着手前の確認のどの依頼にも、
 * 事務局が既定ブランチから取得して保存した本文を添える。起動係は、それを検査してビルドし、
 * できたイメージで実行する。作業場所のファイルは使わない(ワーカーが書き換えられるため)。
 *
 * ビルドできなかった場合は、コマンドの結果と混ざらないように、例外(`ImageBuildError`)にする。
 */
import type { WorkerLauncher } from "../launcher/client.ts";
import type { StoredWorkerDockerfile } from "./product.ts";

/** メッセージに入れる、ビルドの出力の末尾の長さ。 */
const MESSAGE_TAIL_CHARS = 2000;

/**
 * 製品のイメージをビルドできなかったときの例外。コマンドは実行されていない。
 *
 * 起動係に届かない場合や、依頼を拒否された場合と区別できるように、型を分けてある。
 */
export class ImageBuildError extends Error {
  /** `docker build` の終了コード。ビルドを始めなかった場合(検査に通らないなど)は null。 */
  readonly exitCode: number | null;
  /** ビルドの時間の上限で止めたか。 */
  readonly timedOut: boolean;
  /** 理由と、ビルドの出力。 */
  readonly output: string;
  /** 出力が上限を超えて、途中で切られたか。 */
  readonly truncated: boolean;

  constructor(input: {
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    truncated: boolean;
  }) {
    const output = input.output.trim();
    const tail =
      output.length <= MESSAGE_TAIL_CHARS
        ? output
        : `…${output.slice(-MESSAGE_TAIL_CHARS)}`;
    super(`ワーカーのイメージをビルドできませんでした: ${tail}`);
    this.name = "ImageBuildError";
    this.exitCode = input.exitCode;
    this.timedOut = input.timedOut;
    this.output = input.output;
    this.truncated = input.truncated;
  }
}

/**
 * 依頼に、製品の Dockerfile を添える口を作る。
 *
 * `dockerfileFor` は、Dockerfile のない製品では null を返し、あるはずなのに使えない場合は失敗する
 * (`readStoredWorkerDockerfile`)。失敗した場合、依頼は起動係に送らない。
 */
export function withProductImage(
  launcher: WorkerLauncher,
  dockerfileFor: (repo: string) => StoredWorkerDockerfile | null,
): WorkerLauncher {
  return {
    async run(request, options) {
      const dockerfile = dockerfileFor(request.repo);
      const result = await launcher.run(
        dockerfile === null
          ? request
          : { ...request, dockerfile: dockerfile.content },
        options,
      );
      if (result.build === "failed") {
        throw new ImageBuildError({
          exitCode: result.exit_code,
          timedOut: result.timed_out,
          output: result.stderr,
          truncated: result.truncated,
        });
      }
      return result;
    },
  };
}
