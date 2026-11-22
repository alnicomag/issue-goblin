import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseConfig,
  resolveToken,
  workerImageFor,
} from "../src/office/config.ts";

const VALID = `
dry_run: false
poll_interval_sec: 30
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_EXAMPLE
`;

describe("ファクトリー側の設定", () => {
  it("正常な例を読める", () => {
    expect(parseConfig(VALID)).toEqual({
      dry_run: false,
      poll_interval_sec: 30,
      db_path: "/data/factory.db",
      repos_dir: "/data/repos",
      work_dir: "/work",
      logs_dir: "/data/logs",
      worker_image: "factory-worker",
      retry_wait_minutes: [5, 30, 120],
      repos: [{ repo: "owner/name", token_env: "GITHUB_TOKEN_EXAMPLE" }],
    });
  });

  it("置き場所は、名前が前方一致するだけの別の場所なら通す", () => {
    const config = parseConfig(
      VALID.replace("repos_dir: /data/repos", "repos_dir: /work-repos"),
    );
    expect(config.repos_dir).toBe("/work-repos");
    expect(config.work_dir).toBe("/work");
  });

  it("ログの置き場所を指定できる", () => {
    const config = parseConfig(`${VALID}logs_dir: /var/log/factory/\n`);
    expect(config.logs_dir).toBe("/var/log/factory");
  });

  it("失敗後の待機時間を指定できる", () => {
    const config = parseConfig(`${VALID}retry_wait_minutes: [1, 10]\n`);
    expect(config.retry_wait_minutes).toEqual([1, 10]);
  });

  it("失敗後の待機時間は、1つ以上の0以上の整数でなければ通さない", () => {
    for (const value of ["[]", "[5, -1]", "[1.5]", "5", '["5"]']) {
      expect(
        () => parseConfig(`${VALID}retry_wait_minutes: ${value}\n`),
        value,
      ).toThrow("retry_wait_minutes");
    }
  });

  it("ワーカーのイメージは、リポジトリごとの指定が全体の指定より優先される", () => {
    const config = parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
worker_image: registry.example/base-worker:1
repos:
  - repo: owner/first
    token_env: TOKEN_FIRST
  - repo: owner/second
    token_env: TOKEN_SECOND
    worker_image: second-worker
`);
    expect(workerImageFor(config, "owner/first")).toBe(
      "registry.example/base-worker:1",
    );
    expect(workerImageFor(config, "Owner/Second")).toBe("second-worker");
    expect(() => workerImageFor(config, "owner/unknown")).toThrow(
      "設定にないリポジトリです: owner/unknown",
    );
  });

  it("置き場所の外を指すリポジトリ名は通さない", () => {
    for (const repo of ["../name", "owner/..", "./name", "owner/."]) {
      expect(() =>
        parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: ${repo}
    token_env: GITHUB_TOKEN_EXAMPLE
`),
      ).toThrow("repos.0.repo");
    }
  });

  it("オプションに見えるイメージ名は通さない", () => {
    for (const image of ["--privileged", "-v", "Image Name", ""]) {
      expect(() =>
        parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
worker_image: "${image}"
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_EXAMPLE
`),
      ).toThrow("worker_image");
    }
  });

  it("リポジトリに置いた例のファイルを読める", () => {
    const example = fs.readFileSync(
      path.resolve(import.meta.dirname, "../config/factory.config.example.yml"),
      "utf8",
    );
    const config = parseConfig(example);
    expect(config.dry_run).toBe(true);
    expect(config.repos).toEqual([
      { repo: "owner/name", token_env: "GITHUB_TOKEN_EXAMPLE" },
    ]);
  });

  it("dry_run の既定値は true、poll_interval_sec の既定値は 60", () => {
    const config = parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_EXAMPLE
`);
    expect(config.dry_run).toBe(true);
    expect(config.poll_interval_sec).toBe(60);
  });

  it("複数のリポジトリを書ける", () => {
    const config = parseConfig(`
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
repos:
  - repo: owner/first
    token_env: TOKEN_FIRST
  - repo: owner/second
    token_env: TOKEN_SECOND
`);
    expect(config.repos.map((r) => r.repo)).toEqual([
      "owner/first",
      "owner/second",
    ]);
  });

  it.each([
    [
      "db_path の欠落",
      "repos_dir: /data/repos\nwork_dir: /work\nrepos:\n  - repo: owner/name\n    token_env: T\n",
      /db_path/,
    ],
    [
      "repos の欠落",
      "db_path: /data/factory.db\nrepos_dir: /data/repos\nwork_dir: /work\n",
      /repos/,
    ],
    [
      "repos が空",
      "db_path: /data/factory.db\nrepos_dir: /data/repos\nwork_dir: /work\nrepos: []\n",
      /repos/,
    ],
    [
      "token_env の欠落",
      "db_path: /data/factory.db\nrepos_dir: /data/repos\nwork_dir: /work\nrepos:\n  - repo: owner/name\n",
      /repos\.0\.token_env/,
    ],
    ["未知のキー", `${VALID}unknown_key: 1\n`, /unknown_key/],
    [
      "リポジトリ内の未知のキー",
      "db_path: /d\nrepos_dir: /data/repos\nwork_dir: /work\nrepos:\n  - repo: owner/name\n    token_env: T\n    token: abc\n",
      /token/,
    ],
    [
      "dry_run が真偽値でない",
      VALID.replace("dry_run: false", "dry_run: maybe"),
      /dry_run/,
    ],
    [
      "poll_interval_sec が0",
      VALID.replace("poll_interval_sec: 30", "poll_interval_sec: 0"),
      /poll_interval_sec/,
    ],
    [
      "repo の形式が不正",
      VALID.replace("owner/name", "not-a-repo"),
      /repos\.0\.repo/,
    ],
    [
      "token_env が環境変数の名前でない",
      VALID.replace("GITHUB_TOKEN_EXAMPLE", "has space"),
      /repos\.0\.token_env/,
    ],
    [
      "同じリポジトリが2回",
      `${VALID}  - repo: Owner/Name\n    token_env: OTHER\n`,
      /repos\.1\.repo/,
    ],
    [
      "repos_dir の欠落",
      VALID.replace("repos_dir: /data/repos\n", ""),
      /repos_dir/,
    ],
    ["work_dir の欠落", VALID.replace("work_dir: /work\n", ""), /work_dir/],
    [
      "repos_dir が相対パス",
      VALID.replace("repos_dir: /data/repos", "repos_dir: data/repos"),
      /repos_dir/,
    ],
    [
      "work_dir が相対パス",
      VALID.replace("work_dir: /work", "work_dir: ./work"),
      /work_dir/,
    ],
    [
      "repos_dir と work_dir が同じ",
      VALID.replace("repos_dir: /data/repos", "repos_dir: /work/"),
      /repos_dir/,
    ],
    [
      "repos_dir が work_dir の内側",
      VALID.replace("repos_dir: /data/repos", "repos_dir: /work/repos"),
      /repos_dir/,
    ],
    [
      "repos_dir が work_dir の内側(.. を挟む書き方)",
      VALID.replace("repos_dir: /data/repos", "repos_dir: /data/../work/x"),
      /repos_dir/,
    ],
    [
      "work_dir が repos_dir の内側",
      VALID.replace("work_dir: /work", "work_dir: /data/repos/work"),
      /work_dir/,
    ],
    ["logs_dir が相対パス", `${VALID}logs_dir: logs\n`, /logs_dir/],
    [
      "logs_dir が work_dir の内側",
      `${VALID}logs_dir: /work/logs\n`,
      /logs_dir/,
    ],
    ["logs_dir が work_dir を含む", `${VALID}logs_dir: /\n`, /logs_dir/],
    [
      "logs_dir が repos_dir の内側",
      `${VALID}logs_dir: /data/repos/logs\n`,
      /logs_dir/,
    ],
    ["YAMLとして不正", "repos: [", /YAML/],
    ["空のファイル", "", /不正/],
  ])("%s で失敗する", (_name, text, pattern) => {
    expect(() => parseConfig(text)).toThrow(pattern);
  });

  describe("トークン", () => {
    const repo = { repo: "owner/name", token_env: "GITHUB_TOKEN_EXAMPLE" };

    it("環境変数から読む", () => {
      expect(resolveToken(repo, { GITHUB_TOKEN_EXAMPLE: " value \n" })).toBe(
        "value",
      );
    });

    it.each([
      ["未設定", {}],
      ["空", { GITHUB_TOKEN_EXAMPLE: "  " }],
    ])("%s なら、変数名の分かるメッセージで失敗する", (_name, env) => {
      expect(() => resolveToken(repo, env)).toThrow(/GITHUB_TOKEN_EXAMPLE/);
    });
  });
});
