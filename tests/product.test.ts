import { beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { silentLogger } from "../src/office/log.ts";
import { parseFactoryYml, syncFactoryYml } from "../src/office/product.ts";
import { FakeGitHub, VALID_FACTORY_YML } from "./fake-github.ts";

const REPO = "owner/name";
const clock = { now: () => new Date("2026-03-01T01:00:00.000Z") };

describe("factory.yml の検証", () => {
  it("正常な例を読める", () => {
    expect(parseFactoryYml(VALID_FACTORY_YML)).toEqual({
      ok: true,
      value: {
        version: 1,
        level: "A",
        commands: {
          setup: "example-setup",
          test: "example-test",
          lint: "example-lint",
        },
        verify: { unverified: ["example of an unverifiable area"] },
        paths: { protected: ["docs/**"], forbidden: ["generated/**"] },
        limits: { max_parallel: 1, max_attempts: 3 },
        issues: { allowed_authors: ["example-login"] },
      },
    });
  });

  it("省略できる項目には既定値が入る", () => {
    const result = parseFactoryYml(`
version: 1
level: C
commands: { setup: a, test: b, lint: c }
issues: { allowed_authors: [] }
`);
    expect(result).toMatchObject({
      ok: true,
      value: {
        verify: { unverified: [] },
        paths: { protected: [], forbidden: [] },
        limits: { max_parallel: 1, max_attempts: 3 },
      },
    });
  });

  const without = (line: RegExp) => VALID_FACTORY_YML.replace(line, "");

  it.each([
    ["version の欠落", without(/^version: 1\n/m), /version/],
    ["level の欠落", without(/^level: A\n/m), /level/],
    [
      "commands.test の欠落",
      without(/^ {2}test: example-test\n/m),
      /commands\.test/,
    ],
    [
      "issues の欠落",
      VALID_FACTORY_YML.replace(/^issues:[\s\S]*$/m, ""),
      /issues/,
    ],
    ["未知のキー", `${VALID_FACTORY_YML}extra: true\n`, /extra/],
    [
      "入れ子の未知のキー",
      VALID_FACTORY_YML.replace("  setup:", "  deploy: x\n  setup:"),
      /deploy/,
    ],
    [
      "未対応の version",
      VALID_FACTORY_YML.replace("version: 1", "version: 2"),
      /version/,
    ],
    [
      "不正な level",
      VALID_FACTORY_YML.replace("level: A", "level: D"),
      /level/,
    ],
    [
      "max_attempts が0",
      VALID_FACTORY_YML.replace("max_attempts: 3", "max_attempts: 0"),
      /limits\.max_attempts/,
    ],
    [
      "paths.protected が配列でない",
      VALID_FACTORY_YML.replace(
        "  protected:\n    - docs/**",
        "  protected: docs",
      ),
      /paths\.protected/,
    ],
    ["YAMLとして不正", "version: [", /YAML/],
    ["空のファイル", "", /./],
  ])("%s で失敗する", (_name, text, pattern) => {
    const result = parseFactoryYml(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toMatch(pattern);
  });
});

describe("factory.yml の取得と保存", () => {
  let db: Db;
  let fake: FakeGitHub;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, { clock });
    db.prepare("INSERT INTO repos (repo) VALUES (?)").run(REPO);
    fake = new FakeGitHub();
  });

  const run = () =>
    syncFactoryYml({ db, api: fake, repo: REPO, clock, logger: silentLogger });
  const stored = () =>
    db
      .prepare("SELECT factory_yml, factory_yml_sha FROM repos WHERE repo = ?")
      .get(REPO) as {
      factory_yml: string | null;
      factory_yml_sha: string | null;
    };
  const eventTypes = () =>
    (
      db.prepare("SELECT type FROM events ORDER BY id").all() as {
        type: string;
      }[]
    ).map((row) => row.type);

  it("検証した内容をJSONで保存する", async () => {
    fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };

    expect(await run()).toBe("updated");

    const row = stored();
    expect(row.factory_yml_sha).toBe("sha-1");
    expect(JSON.parse(row.factory_yml as string)).toMatchObject({
      version: 1,
      level: "A",
    });
    expect(eventTypes()).toEqual([]);
  });

  it("内容が変わっていなければ、保存し直さない", async () => {
    fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };
    await run();
    db.prepare("UPDATE repos SET factory_yml = 'sentinel'").run();

    expect(await run()).toBe("unchanged");

    expect(stored().factory_yml).toBe("sentinel");
    expect(fake.calls.at(-1)).toMatchObject({
      method: "getFile",
      knownSha: "sha-1",
    });
  });

  it("不正なら repo.config_invalid を1回だけ記録し、保存済みの内容を消す", async () => {
    fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };
    await run();
    fake.file = { sha: "sha-2", content: `${VALID_FACTORY_YML}extra: 1\n` };

    expect(await run()).toBe("invalid");
    expect(await run()).toBe("unchanged");

    expect(stored()).toEqual({ factory_yml: null, factory_yml_sha: "sha-2" });
    expect(eventTypes()).toEqual(["repo.config_invalid"]);
    const payload = JSON.parse(
      (db.prepare("SELECT payload FROM events").get() as { payload: string })
        .payload,
    );
    expect(payload).toMatchObject({ path: "factory.yml", sha: "sha-2" });
    expect(payload.errors).toMatch(/extra/);
  });

  it("ファイルがなければ repo.config_missing を1回だけ記録する", async () => {
    expect(await run()).toBe("missing");
    expect(await run()).toBe("missing");

    expect(eventTypes()).toEqual(["repo.config_missing"]);
    expect(stored()).toEqual({ factory_yml: null, factory_yml_sha: null });
  });

  it("直ったあとでまた不正や欠落になったら、あらためて記録する", async () => {
    await run(); // 欠落
    fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };
    await run(); // 正常
    fake.file = null;
    await run(); // 欠落
    fake.file = { sha: "sha-2", content: "version: 2" };
    await run(); // 不正
    fake.file = null;
    await run(); // 欠落
    await run();

    expect(eventTypes()).toEqual([
      "repo.config_missing",
      "repo.config_missing",
      "repo.config_invalid",
      "repo.config_missing",
    ]);
  });
});
