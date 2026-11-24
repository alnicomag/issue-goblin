/**
 * 製品の Dockerfile からビルドするイメージの形。名前と、`docker build` の引数を組み立てる純粋関数。
 *
 * ビルドの `RUN` から見えるものは、ここで決まる。依頼から来る値が入るのは、
 * Dockerfile の本文(標準入力で渡す)だけで、引数には入らない。
 */
import { createHash } from "node:crypto";
import type { ContainerSettings } from "./container.ts";
import { BASE_IMAGE_ARG } from "./dockerfile.ts";

/** ビルドしたイメージの名前(タグの前)。タグは、内容から決まるハッシュにする。 */
export const BUILT_IMAGE_REPOSITORY = "factory-built";

/**
 * ビルドしたイメージに付ける目印の名前。古いイメージの片付けに使う。
 * 値は作業場所のボリュームの名前にして、同じホストの別のファクトリーのものと区別する。
 */
export const BUILT_LABEL = "factory.built";
/** ビルドしたイメージに付ける、製品を表す目印の名前。値は、設定にある書き方のリポジトリ名。 */
export const BUILT_REPO_LABEL = "factory.repo";

/** ビルドのときに使う、`docker` コマンドの環境変数。旧ビルダーを選ぶ。 */
export const BUILD_ENV: Readonly<Record<string, string>> = {
  // ネットワークを名前で指定できるのは、旧ビルダーだけである。
  DOCKER_BUILDKIT: "0",
};

/**
 * ビルドするイメージの名前。作業場所のボリュームの名前、リポジトリ名、基本イメージのID、
 * Dockerfile の本文から決まる。どれかが変われば、名前が変わる。
 */
export function builtImageName(input: {
  settings: Pick<ContainerSettings, "workVolume">;
  /** 設定にある書き方のリポジトリ名。 */
  repo: string;
  /** 基本イメージのID(`docker image inspect` の `.Id`)。 */
  baseImageId: string;
  dockerfile: string;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.settings.workVolume,
        input.repo.toLowerCase(),
        input.baseImageId,
        input.dockerfile,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${BUILT_IMAGE_REPOSITORY}:${hash}`;
}

/** この起動係がビルドした、ある製品のイメージを探すための絞り込み(`docker image ls` の引数)。 */
export function builtImageFilters(
  settings: Pick<ContainerSettings, "workVolume">,
  repo: string,
): string[] {
  return [
    `--filter=label=${BUILT_LABEL}=${settings.workVolume}`,
    `--filter=label=${BUILT_REPO_LABEL}=${repo}`,
  ];
}

/**
 * `docker build` に渡す引数(`docker` 自体は含まない)。Dockerfile は、標準入力で渡す。
 * ビルドコンテキストは渡さない。
 */
export function buildBuildArgs(input: {
  settings: ContainerSettings;
  /** 設定にある書き方のリポジトリ名。 */
  repo: string;
  /** 基本イメージの名前(設定のもの)。 */
  baseImage: string;
  /** 付ける名前(`builtImageName` の結果)。 */
  image: string;
}): string[] {
  const { settings, repo, baseImage, image } = input;
  for (const [name, value] of [
    ["基本イメージ", baseImage],
    ["イメージ", image],
  ] as const) {
    if (value === "" || value.startsWith("-")) {
      throw new Error(`${name}の名前が不正です: ${value}`);
    }
  }
  return [
    "build",
    // 失敗しても、途中のコンテナを残さない。
    "--force-rm",
    // `RUN` を、ワーカーと同じ、外への経路がないネットワークに置く。
    `--network=${settings.network}`,
    `--memory=${settings.memory}`,
    `--build-arg=${BASE_IMAGE_ARG}=${baseImage}`,
    // 外へは、プロキシだけを通る。これらは Docker があらかじめ用意している引数で、
    // Dockerfile に宣言しなくても `RUN` から見え、イメージの履歴には残らない。
    `--build-arg=HTTPS_PROXY=${settings.proxyUrl}`,
    `--build-arg=HTTP_PROXY=${settings.proxyUrl}`,
    `--build-arg=https_proxy=${settings.proxyUrl}`,
    `--build-arg=http_proxy=${settings.proxyUrl}`,
    `--label=${BUILT_LABEL}=${settings.workVolume}`,
    `--label=${BUILT_REPO_LABEL}=${repo}`,
    `--tag=${image}`,
    // Dockerfile だけを、標準入力から読む。
    "-",
  ];
}

/** 旧ビルダーでワーカーのネットワークを指定できるかを試すための、基本イメージだけの Dockerfile。 */
export const BUILDER_PROBE_DOCKERFILE = `ARG ${BASE_IMAGE_ARG}\nFROM \${${BASE_IMAGE_ARG}}\n`;

/**
 * 旧ビルダーを試す `docker build` の引数。名前もラベルも付けないので、新しいイメージはできない。
 */
export function buildProbeArgs(input: {
  settings: Pick<ContainerSettings, "network">;
  baseImage: string;
}): string[] {
  if (input.baseImage === "" || input.baseImage.startsWith("-")) {
    throw new Error(`基本イメージの名前が不正です: ${input.baseImage}`);
  }
  return [
    "build",
    `--network=${input.settings.network}`,
    `--build-arg=${BASE_IMAGE_ARG}=${input.baseImage}`,
    "-",
  ];
}
