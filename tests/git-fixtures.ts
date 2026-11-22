/** テスト用の仮のリポジトリ。手元の一時ディレクトリに作り、ネットワークには出ない。 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 守りを付けない素のgit。仮のリポジトリの用意と、結果の確認に使う。 */
export function plainGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "factory-test-"));
}

/** ファイルを1つ足してコミットし、そのハッシュを返す。 */
export function commitFile(
  repoDir: string,
  name: string,
  content: string,
): string {
  fs.writeFileSync(path.join(repoDir, name), content);
  plainGit(repoDir, "add", "--", name);
  plainGit(repoDir, "commit", "--quiet", "--no-verify", "-m", `add ${name}`);
  return plainGit(repoDir, "rev-parse", "HEAD");
}

/** コミットを1つ持つ仮のリポジトリを作る。 */
export function makeRepo(dir: string, branch = "main"): string {
  fs.mkdirSync(dir, { recursive: true });
  plainGit(dir, "init", "--quiet", `--initial-branch=${branch}`);
  commitFile(dir, "README.txt", "example\n");
  return dir;
}

/** 実行されたら `marker` に自分の名前を書き足すフックを、`hooksDir` に置く。 */
export function plantHooks(hooksDir: string, marker: string): void {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of [
    "pre-commit",
    "commit-msg",
    "post-commit",
    "post-checkout",
    "reference-transaction",
    "fsmonitor",
  ]) {
    fs.writeFileSync(
      path.join(hooksDir, name),
      `#!/bin/sh\necho ${name} >> '${marker}'\n`,
      { mode: 0o755 },
    );
  }
}
