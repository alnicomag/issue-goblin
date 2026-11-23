import { beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { silentLogger } from "../src/office/log.ts";
import { checkPaths } from "../src/office/paths.ts";
import {
  parseFactoryYml,
  readStoredFactoryYml,
  syncFactoryYml,
} from "../src/office/product.ts";
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

describe("factory.yml の paths のパターンの検証", () => {
  const withPaths = (forbidden: string[], protectedPaths: string[]) =>
    `
version: 1
level: A
commands: { setup: a, test: b, lint: c }
paths:
  forbidden: ${JSON.stringify(forbidden)}
  protected: ${JSON.stringify(protectedPaths)}
issues: { allowed_authors: [] }
`;

  it("対応している書き方だけなら、通る", () => {
    const result = parseFactoryYml(
      withPaths(
        ["generated/**", "**/*.lock", "secrets/"],
        ["CLAUDE.md", "docs/?.md", "a/**/b", ".github/*"],
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        paths: {
          forbidden: ["generated/**", "**/*.lock", "secrets/"],
          protected: ["CLAUDE.md", "docs/?.md", "a/**/b", ".github/*"],
        },
      },
    });
  });

  it.each([
    ["文字の集合", "docs/[a-z]*.md", "*、?、**"],
    ["波かっこ", "docs/{a,b}.md", "*、?、**"],
    ["否定", "!docs/keep.md", "否定"],
    ["先頭の /", "/docs/**", "相対パス"],
    ["区切りにはさまれていない **", "docs/**.md", "**"],
    [". と ..", "../outside", ". と .."],
  ])(
    "%s は、forbidden でも protected でも失敗する",
    (_name, pattern, reason) => {
      const inForbidden = parseFactoryYml(withPaths(["ok/**", pattern], []));
      expect(inForbidden.ok).toBe(false);
      if (!inForbidden.ok) {
        expect(inForbidden.errors).toContain("paths.forbidden.1:");
        expect(inForbidden.errors).toContain(JSON.stringify(pattern));
        expect(inForbidden.errors).toContain(reason);
        expect(inForbidden.errors).not.toContain("paths.protected");
      }

      const inProtected = parseFactoryYml(withPaths([], [pattern, "ok/**"]));
      expect(inProtected.ok).toBe(false);
      if (!inProtected.ok) {
        expect(inProtected.errors).toContain("paths.protected.0:");
        expect(inProtected.errors).toContain(JSON.stringify(pattern));
        expect(inProtected.errors).toContain(reason);
        expect(inProtected.errors).not.toContain("paths.forbidden");
      }
    },
  );

  it("読めないパターンが複数あれば、すべて挙げる", () => {
    const result = parseFactoryYml(
      withPaths(["a/[b]", "ok/**", "!c"], ["ok", "{d}"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.split("\n")).toEqual([
        '  paths.protected.1: パスのパターンを読めません: "{d}"(使えるのは *、?、** だけです)',
        '  paths.forbidden.0: パスのパターンを読めません: "a/[b]"(使えるのは *、?、** だけです)',
        '  paths.forbidden.2: パスのパターンを読めません: "!c"(否定には対応していません)',
      ]);
    }
  });

  it("理由は、publish の照合(checkPaths)が出すものと同じである", () => {
    const pattern = "docs/[a-z]*.md";
    const result = parseFactoryYml(withPaths([pattern], []));
    let thrown = "";
    try {
      checkPaths([], { forbidden: [pattern], protected: [] });
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).not.toBe("");
    expect(result).toEqual({
      ok: false,
      errors: `  paths.forbidden.0: ${thrown}`,
    });
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

  it("読めないパターンがあれば、保存せずに、項目とパターンと理由を記録する", async () => {
    fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };
    await run();
    fake.file = {
      sha: "sha-2",
      content: VALID_FACTORY_YML.replace(
        "- generated/**",
        "- generated/**\n    - secrets/{a,b}.txt",
      ),
    };
    const warnings: { event: string; fields: unknown }[] = [];
    const logger = {
      ...silentLogger,
      warn: (event: string, fields?: unknown) => {
        warnings.push({ event, fields });
      },
    };

    expect(
      await syncFactoryYml({ db, api: fake, repo: REPO, clock, logger }),
    ).toBe("invalid");

    expect(stored()).toEqual({ factory_yml: null, factory_yml_sha: "sha-2" });
    expect(eventTypes()).toEqual(["repo.config_invalid"]);
    const errors =
      '  paths.forbidden.1: パスのパターンを読めません: "secrets/{a,b}.txt"(使えるのは *、?、** だけです)';
    const payload = JSON.parse(
      (db.prepare("SELECT payload FROM events").get() as { payload: string })
        .payload,
    );
    expect(payload).toEqual({ path: "factory.yml", sha: "sha-2", errors });
    expect(warnings).toEqual([
      {
        event: "product.config_invalid",
        fields: { repo: REPO, path: "factory.yml", errors },
      },
    ]);
  });

  it("対応している書き方だけのパターンは、これまでどおり保存する", async () => {
    fake.file = {
      sha: "sha-1",
      content: VALID_FACTORY_YML.replace(
        "- generated/**",
        "- generated/**\n    - '**/*.lock'\n    - secrets/\n    - notes/?.md",
      ),
    };

    expect(await run()).toBe("updated");

    expect(JSON.parse(stored().factory_yml as string).paths).toEqual({
      protected: ["docs/**"],
      forbidden: ["generated/**", "**/*.lock", "secrets/", "notes/?.md"],
    });
    expect(eventTypes()).toEqual([]);
    expect(readStoredFactoryYml(db, REPO).paths.forbidden).toHaveLength(4);
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

describe("保存済みの factory.yml の読み出し", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, { clock });
  });

  const insert = (content: string | null, sha: string | null) =>
    db
      .prepare(
        "INSERT INTO repos (repo, factory_yml, factory_yml_sha) VALUES (?, ?, ?)",
      )
      .run(REPO, content, sha);

  it("保存してある内容を、検証して返す", () => {
    const parsed = parseFactoryYml(VALID_FACTORY_YML);
    if (!parsed.ok) throw new Error(parsed.errors);
    insert(JSON.stringify(parsed.value), "sha-1");
    expect(readStoredFactoryYml(db, REPO)).toEqual(parsed.value);
  });

  it("同期していないリポジトリは、未取得として失敗する", () => {
    expect(() => readStoredFactoryYml(db, REPO)).toThrow(/owner\/name.*未取得/);
  });

  it("factory.yml を取得していなければ、未取得として失敗する", () => {
    insert(null, null);
    expect(() => readStoredFactoryYml(db, REPO)).toThrow(
      /factory\.yml は未取得/,
    );
  });

  it("factory.yml が検証に通らなかった場合は、不正として失敗する", () => {
    insert(null, "sha-bad");
    expect(() => readStoredFactoryYml(db, REPO)).toThrow(
      /factory\.yml が不正.*sha-bad/,
    );
  });

  it("保存してある内容が壊れていれば、項目名の分かるメッセージで失敗する", () => {
    insert("{", "sha-1");
    expect(() => readStoredFactoryYml(db, REPO)).toThrow(
      /JSONとして読めません/,
    );
    db.prepare("UPDATE repos SET factory_yml = ?").run(
      JSON.stringify({ version: 1 }),
    );
    expect(() => readStoredFactoryYml(db, REPO)).toThrow(/commands/);
  });

  it("保存してある内容に読めないパターンがあれば、項目とパターンの分かるメッセージで失敗する", () => {
    const parsed = parseFactoryYml(VALID_FACTORY_YML);
    if (!parsed.ok) throw new Error(parsed.errors);
    // 検証が入る前に保存された内容を模す。
    const old = {
      ...parsed.value,
      paths: { protected: ["docs/**", "docs/[a-z]*.md"], forbidden: [] },
    };
    insert(JSON.stringify(old), "sha-1");
    expect(() => readStoredFactoryYml(db, REPO)).toThrow(
      'paths.protected.1: パスのパターンを読めません: "docs/[a-z]*.md"(使えるのは *、?、** だけです)',
    );
  });
});
