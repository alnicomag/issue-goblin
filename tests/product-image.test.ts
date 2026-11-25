import { describe, expect, it } from "vitest";
import type { WorkerLauncher } from "../src/launcher/client.ts";
import type { RunRequestInput, RunResult } from "../src/launcher/request.ts";
import {
  ImageBuildError,
  withProductImage,
} from "../src/office/product-image.ts";

const REQUEST: RunRequestInput = {
  repo: "owner/name",
  issue: 3,
  argv: ["sh", "-c", "example-test"],
  timeout_sec: 60,
};

const RESULT: RunResult = {
  exit_code: 0,
  timed_out: false,
  stdout: "out",
  stderr: "",
  truncated: false,
};

function fakeLauncher(answer: RunResult = RESULT) {
  const requests: RunRequestInput[] = [];
  const options: unknown[] = [];
  const launcher: WorkerLauncher = {
    async run(request, runOptions) {
      requests.push(request);
      options.push(runOptions);
      return answer;
    },
  };
  return { launcher, requests, options };
}

const DOCKERFILE = {
  path: ".factory/worker.Dockerfile",
  sha: "d-1",
  content: "ARG FACTORY_BASE_IMAGE\nFROM $FACTORY_BASE_IMAGE\n",
};

describe("依頼に、製品の Dockerfile を添える", () => {
  it("Dockerfile のない製品の依頼は、そのまま渡す", async () => {
    const fake = fakeLauncher();
    const launcher = withProductImage(fake.launcher, () => null);
    expect(await launcher.run(REQUEST)).toEqual(RESULT);
    expect(fake.requests).toEqual([REQUEST]);
  });

  it("Dockerfile のある製品では、保存してある本文を添える。中断の合図も渡す", async () => {
    const fake = fakeLauncher({ ...RESULT, build: "cached" });
    const asked: string[] = [];
    const launcher = withProductImage(fake.launcher, (repo) => {
      asked.push(repo);
      return DOCKERFILE;
    });
    const signal = new AbortController().signal;

    const result = await launcher.run(
      { ...REQUEST, claude_token: true },
      { signal },
    );

    expect(result).toEqual({ ...RESULT, build: "cached" });
    expect(asked).toEqual(["owner/name"]);
    expect(fake.requests).toEqual([
      { ...REQUEST, claude_token: true, dockerfile: DOCKERFILE.content },
    ]);
    expect(fake.options).toEqual([{ signal }]);
  });

  it("依頼の側で Dockerfile を指定しても、保存してあるものが使われる", async () => {
    const fake = fakeLauncher();
    const launcher = withProductImage(fake.launcher, () => DOCKERFILE);
    await launcher.run({ ...REQUEST, dockerfile: "FROM other\n" });
    expect(fake.requests[0]?.dockerfile).toBe(DOCKERFILE.content);
  });

  it("Dockerfile を使えない製品の依頼は、起動係に送らずに失敗する", async () => {
    const fake = fakeLauncher();
    const launcher = withProductImage(fake.launcher, () => {
      throw new Error("Dockerfile を使えません");
    });
    await expect(launcher.run(REQUEST)).rejects.toThrow(
      "Dockerfile を使えません",
    );
    expect(fake.requests).toEqual([]);
  });

  it("ビルドに失敗した結果は、コマンドの結果と混ざらないように、例外にする", async () => {
    const fake = fakeLauncher({
      exit_code: 1,
      timed_out: false,
      stdout: "",
      stderr: `イメージのビルドに失敗しました\n${"x".repeat(5000)}\nexample-install: not found\n`,
      truncated: true,
      build: "failed",
    });
    const launcher = withProductImage(fake.launcher, () => DOCKERFILE);

    const error = await launcher
      .run(REQUEST)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImageBuildError);
    const failure = error as ImageBuildError;
    expect(failure).toMatchObject({
      exitCode: 1,
      timedOut: false,
      truncated: true,
    });
    expect(failure.output).toContain("イメージのビルドに失敗しました");
    // メッセージには、出力の末尾だけを入れる。
    expect(failure.message).toMatch(
      /^ワーカーのイメージをビルドできませんでした: …x+\nexample-install: not found$/,
    );
    expect(failure.message.length).toBeLessThan(2100);
  });
});
