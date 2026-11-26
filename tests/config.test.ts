import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTED_COMMIT_AUTHORS } from "../scripts/commit-author-examples.ts";
import { MAX_TIMEOUT_SEC } from "../src/launcher/request.ts";
import {
  parseConfig,
  resolveToken,
  stepLimitsFrom,
  workerImageFor,
} from "../src/office/config.ts";
import { DEFAULT_STEP_LIMITS } from "../src/office/step-limits.ts";

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
      daily_run_limit: 20,
      commit_author: {
        name: "factory-worker",
        email: "factory-worker@example.invalid",
      },
      step_limits: {
        plan: { timeout_sec: 1800, max_turns: 50 },
        implement: { timeout_sec: 7200, max_turns: 200 },
        review: { timeout_sec: 1800, max_turns: 50 },
        verify: { timeout_sec: 1800 },
      },
      repos: [
        {
          repo: "owner/name",
          token_env: "GITHUB_TOKEN_EXAMPLE",
          assigned_only: false,
        },
      ],
    });
  });

  it("assigned_only は、リポジトリごとに有効にできる。真偽値のほかは通さない", () => {
    const enabled = parseConfig(`${VALID}    assigned_only: true\n`);
    expect(enabled.repos[0]?.assigned_only).toBe(true);
    expect(() =>
      parseConfig(`${VALID}    assigned_only: example-login\n`),
    ).toThrow(/repos\.0\.assigned_only/);
  });

  describe("ステップの上限", () => {
    /** これまでの上限(設定に出す前の定数)。 */
    const BEFORE = {
      plan: { timeoutSec: 30 * 60, maxTurns: 50 },
      implement: { timeoutSec: 2 * 60 * 60, maxTurns: 200 },
      review: { timeoutSec: 30 * 60, maxTurns: 50 },
      verifyTimeoutSec: 30 * 60,
    };

    it("省略すると、これまでと同じ上限になる", () => {
      expect(DEFAULT_STEP_LIMITS).toEqual(BEFORE);
      expect(stepLimitsFrom(parseConfig(VALID))).toEqual(BEFORE);
      expect(stepLimitsFrom(parseConfig(`${VALID}step_limits: {}\n`))).toEqual(
        BEFORE,
      );
    });

    it("書いた項目だけが変わり、省略した項目は既定値になる", () => {
      const config = parseConfig(`${VALID}step_limits:
  plan:
    timeout_sec: 600
  implement:
    max_turns: 300
  verify:
    timeout_sec: 900
`);
      expect(stepLimitsFrom(config)).toEqual({
        plan: { timeoutSec: 600, maxTurns: 50 },
        implement: { timeoutSec: 7200, maxTurns: 300 },
        review: { timeoutSec: 1800, maxTurns: 50 },
        verifyTimeoutSec: 900,
      });
    });

    it("すべての項目を指定できる。時間は、起動係の上限ちょうどまで通る", () => {
      const config = parseConfig(`${VALID}step_limits:
  plan: { timeout_sec: 1, max_turns: 1 }
  implement: { timeout_sec: ${MAX_TIMEOUT_SEC}, max_turns: 1000 }
  review: { timeout_sec: 120, max_turns: 20 }
  verify: { timeout_sec: ${MAX_TIMEOUT_SEC} }
`);
      expect(stepLimitsFrom(config)).toEqual({
        plan: { timeoutSec: 1, maxTurns: 1 },
        implement: { timeoutSec: MAX_TIMEOUT_SEC, maxTurns: 1000 },
        review: { timeoutSec: 120, maxTurns: 20 },
        verifyTimeoutSec: MAX_TIMEOUT_SEC,
      });
    });

    const ITEMS = [
      "plan.timeout_sec",
      "plan.max_turns",
      "implement.timeout_sec",
      "implement.max_turns",
      "review.timeout_sec",
      "review.max_turns",
      "verify.timeout_sec",
    ];

    function withItem(item: string, value: string): string {
      const [step, key] = item.split(".");
      return `${VALID}step_limits:\n  ${step}:\n    ${key}: ${value}\n`;
    }

    function messagePattern(item: string): RegExp {
      return new RegExp(`step_limits\\.${item.replace(".", "\\.")}: `);
    }

    it.each(ITEMS)("%s は、0以下や整数でない値を通さない", (item) => {
      for (const value of ["0", "-1", "1.5", '"60"', "null"]) {
        expect(() => parseConfig(withItem(item, value)), value).toThrow(
          messagePattern(item),
        );
      }
    });

    it.each(ITEMS.filter((item) => item.endsWith("timeout_sec")))(
      "%s は、起動係の時間の上限を超える値を通さない",
      (item) => {
        expect(() =>
          parseConfig(withItem(item, String(MAX_TIMEOUT_SEC + 1))),
        ).toThrow(messagePattern(item));
        expect(() =>
          parseConfig(withItem(item, String(MAX_TIMEOUT_SEC + 1))),
        ).toThrow(String(MAX_TIMEOUT_SEC));
      },
    );

    it("知らないステップや項目は通さない", () => {
      expect(() =>
        parseConfig(`${VALID}step_limits:\n  publish:\n    timeout_sec: 60\n`),
      ).toThrow(/step_limits/);
      expect(() =>
        parseConfig(`${VALID}step_limits:\n  plan:\n    max_turn: 60\n`),
      ).toThrow(/step_limits\.plan/);
      expect(() =>
        parseConfig(`${VALID}step_limits:\n  verify:\n    max_turns: 60\n`),
      ).toThrow(/step_limits\.verify/);
    });
  });

  it("コミットの作者の既定値は、実在の宛先に届かないメールアドレスになる", () => {
    const { commit_author } = parseConfig(VALID);
    expect(commit_author.name).not.toBe("");
    // `.invalid` は予約済みで、実在のドメインにならない(RFC 2606)。
    expect(commit_author.email).toMatch(/^[^@\s]+@[^@\s]+\.invalid$/);
  });

  it("コミットの作者を指定できる。片方だけ書けば、もう片方は既定値になる", () => {
    expect(
      parseConfig(
        `${VALID}commit_author:\n  name: Example Bot\n  email: bot@example.invalid\n`,
      ).commit_author,
    ).toEqual({ name: "Example Bot", email: "bot@example.invalid" });
    expect(
      parseConfig(`${VALID}commit_author:\n  name: Example Bot\n`)
        .commit_author,
    ).toEqual({
      name: "Example Bot",
      email: "factory-worker@example.invalid",
    });
  });

  describe("gitがコミットに書くときに変えてしまう作者", () => {
    /** gitが、名前とメールアドレスの前後から落とす文字。 */
    const DROPPED = [" ", "\t", "\u0001", ".", ",", ":", ";", '"', "'", "\\"];
    const withAuthor = (field: "name" | "email", value: string) =>
      // JSONの文字列は、YAMLの二重引用符の文字列としても読める。
      `${VALID}commit_author:\n  ${field}: ${JSON.stringify(value)}\n`;

    it("名前の先頭か末尾に、空白やgitが落とす記号があれば、通さない", () => {
      for (const dropped of DROPPED) {
        for (const name of [`Bot${dropped}`, `${dropped}Bot`]) {
          expect(
            () => parseConfig(withAuthor("name", name)),
            JSON.stringify(name),
          ).toThrow(/commit_author\.name.*先頭と末尾/);
        }
      }
    });

    it("メールアドレスの先頭か末尾に、gitが落とす文字があれば、通さない", () => {
      for (const dropped of DROPPED) {
        for (const email of [
          `bot@example.invalid${dropped}`,
          `${dropped}bot@example.invalid`,
        ]) {
          expect(
            () => parseConfig(withAuthor("email", email)),
            JSON.stringify(email),
          ).toThrow("commit_author.email");
        }
      }
    });

    it("途中にこれらの文字がある名前とメールアドレスは、そのまま通る", () => {
      for (const author of ACCEPTED_COMMIT_AUTHORS) {
        expect(
          parseConfig(`${VALID}commit_author: ${JSON.stringify(author)}\n`)
            .commit_author,
        ).toEqual(author);
      }
    });

    it("既定値は通る", () => {
      const { commit_author } = parseConfig(VALID);
      expect(
        parseConfig(`${VALID}commit_author: ${JSON.stringify(commit_author)}\n`)
          .commit_author,
      ).toEqual(commit_author);
    });
  });

  it("コミットの作者に、空の値やgitが作者として扱えない文字は通さない", () => {
    for (const entry of [
      'name: ""',
      'name: "  "',
      'name: "a\\nb"',
      'name: "a <b>"',
      'email: ""',
      "email: no-at-sign",
      'email: "a b@example.invalid"',
      'email: "<a@example.invalid>"',
      'email: "a@example.invalid\\nb"',
      "nickname: example",
    ]) {
      expect(
        () => parseConfig(`${VALID}commit_author:\n  ${entry}\n`),
        entry,
      ).toThrow("commit_author");
    }
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

  it("1日の実行数の上限を指定できる。0以上の整数でなければ通さない", () => {
    expect(parseConfig(`${VALID}daily_run_limit: 3\n`).daily_run_limit).toBe(3);
    expect(parseConfig(`${VALID}daily_run_limit: 0\n`).daily_run_limit).toBe(0);
    for (const value of ["-1", "1.5", '"20"']) {
      expect(
        () => parseConfig(`${VALID}daily_run_limit: ${value}\n`),
        value,
      ).toThrow("daily_run_limit");
    }
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
      {
        repo: "owner/name",
        token_env: "GITHUB_TOKEN_EXAMPLE",
        assigned_only: false,
      },
    ]);
    // 例には、既定値をそのまま書く。
    expect(example).toMatch(/^step_limits:/m);
    expect(stepLimitsFrom(config)).toEqual(DEFAULT_STEP_LIMITS);
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
