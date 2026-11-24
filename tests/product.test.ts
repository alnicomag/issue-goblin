import { beforeEach, describe, expect, it } from "vitest";
import { MAX_DOCKERFILE_BYTES } from "../src/launcher/request.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { type Logger, silentLogger } from "../src/office/log.ts";
import { checkPaths } from "../src/office/paths.ts";
import {
  parseFactoryYml,
  pathRulesOf,
  readStoredFactoryYml,
  readStoredWorkerDockerfile,
  storedWorkerDockerfileSha,
  syncFactoryYml,
  syncWorkerDockerfile,
  workerDockerfilePath,
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

  describe("worker.dockerfile", () => {
    const withWorker = (worker: string) =>
      `${VALID_FACTORY_YML}worker:\n${worker}\n`;
    const parsed = (text: string) => {
      const result = parseFactoryYml(text);
      if (!result.ok) throw new Error(result.errors);
      return result.value;
    };

    it("書いていなければ、Dockerfile の場所はなく、規則も paths のまま", () => {
      const value = parsed(VALID_FACTORY_YML);
      expect(value.worker).toBeUndefined();
      expect(workerDockerfilePath(value)).toBeNull();
      expect(pathRulesOf(value)).toEqual(value.paths);
      // worker だけを書いて、dockerfile を書かない場合も同じ。
      expect(workerDockerfilePath(parsed(withWorker("  {}")))).toBeNull();
    });

    it.each([
      "worker.Dockerfile",
      ".factory/worker.Dockerfile",
      "tools/ci_image/Dockerfile-worker.v2",
    ])("リポジトリの中の相対パス %s を読める", (path) => {
      const value = parsed(withWorker(`  dockerfile: ${path}`));
      expect(workerDockerfilePath(value)).toBe(path);
    });

    it.each([
      ["", "空です"],
      ["/etc/worker.Dockerfile", "相対パスで書いてください"],
      ["../worker.Dockerfile", ". と .. は使えません"],
      [".factory/../../worker.Dockerfile", ". と .. は使えません"],
      ["./worker.Dockerfile", ". と .. は使えません"],
      [".factory//worker.Dockerfile", "区切りが続いているか、末尾にあります"],
      [".factory/", "区切りが続いているか、末尾にあります"],
      [".factory/*.Dockerfile", "使えるのは、英数字と . _ - / だけです"],
      [".factory/worker?.Dockerfile", "使えるのは、英数字と . _ - / だけです"],
      [".factory\\worker.Dockerfile", "使えるのは、英数字と . _ - / だけです"],
      ["my worker.Dockerfile", "使えるのは、英数字と . _ - / だけです"],
      [`${"a".repeat(256)}`, "長すぎます"],
    ])(
      "リポジトリの外に出るパスや、読めない書き方 %j は失敗する",
      (path, reason) => {
        const result = parseFactoryYml(
          withWorker(`  dockerfile: ${JSON.stringify(path)}`),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors).toContain("worker.dockerfile:");
          expect(result.errors).toContain(reason);
        }
      },
    );

    it("文字列でない値と、知らない項目は失敗する", () => {
      expect(parseFactoryYml(withWorker("  dockerfile: [a]")).ok).toBe(false);
      expect(parseFactoryYml(withWorker("  image: other")).ok).toBe(false);
    });

    it("Dockerfile のパスは、paths.protected に書いていなくても、保護対象になる", () => {
      const value = parsed(
        withWorker("  dockerfile: .factory/worker.Dockerfile"),
      );
      const rules = pathRulesOf(value);
      expect(rules).toEqual({
        forbidden: ["generated/**"],
        protected: ["docs/**", ".factory/worker.Dockerfile"],
      });
      expect(
        checkPaths(
          [".factory/worker.Dockerfile", ".factory/other", "src/a.ts"],
          rules,
        ),
      ).toEqual({
        forbidden: [],
        protected: [
          {
            path: ".factory/worker.Dockerfile",
            pattern: ".factory/worker.Dockerfile",
          },
        ],
      });
    });

    it("すでに paths.protected に書いてあれば、重ねて足さない", () => {
      const value = parsed(
        withWorker("  dockerfile: docs/worker.Dockerfile").replace(
          "- docs/**",
          "- docs/worker.Dockerfile",
        ),
      );
      expect(pathRulesOf(value).protected).toEqual(["docs/worker.Dockerfile"]);
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

describe("製品の Dockerfile の取得と保存", () => {
  const DOCKERFILE_PATH = ".factory/worker.Dockerfile";
  const WITH_DOCKERFILE = `${VALID_FACTORY_YML}worker:\n  dockerfile: ${DOCKERFILE_PATH}\n`;
  const CONTENT = "ARG FACTORY_BASE_IMAGE\nFROM $FACTORY_BASE_IMAGE\n";

  let db: Db;
  let fake: FakeGitHub;
  let logged: { level: string; event: string }[];
  let logger: Logger;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, { clock });
    db.prepare("INSERT INTO repos (repo) VALUES (?)").run(REPO);
    fake = new FakeGitHub();
    logged = [];
    const log = (level: string) => (event: string) => {
      logged.push({ level, event });
    };
    logger = { info: log("info"), warn: log("warn"), error: log("error") };
  });

  const sync = async (factoryYml: string | null = WITH_DOCKERFILE) => {
    fake.file =
      factoryYml === null
        ? null
        : { sha: `yml-${factoryYml.length}`, content: factoryYml };
    await syncFactoryYml({ db, api: fake, repo: REPO, clock, logger });
    logged = [];
    return syncWorkerDockerfile({ db, api: fake, repo: REPO, logger });
  };
  const stored = () =>
    db
      .prepare(
        `SELECT worker_dockerfile AS content, worker_dockerfile_sha AS sha,
                worker_dockerfile_path AS path FROM repos WHERE repo = ?`,
      )
      .get(REPO);
  const fileCalls = () =>
    fake.calls.filter(
      (call) => call.method === "getFile" && call.path !== "factory.yml",
    );

  it("factory.yml に書かれていなければ、取得せず、Dockerfile なしとして扱う", async () => {
    fake.files.set(DOCKERFILE_PATH, { sha: "d-1", content: CONTENT });
    expect(await sync(VALID_FACTORY_YML)).toBe("none");
    expect(fileCalls()).toEqual([]);
    expect(stored()).toEqual({ content: null, sha: null, path: null });
    expect(readStoredWorkerDockerfile(db, REPO)).toBeNull();
    expect(storedWorkerDockerfileSha(db, REPO)).toBeNull();
  });

  it("既定ブランチの内容を取得して保存し、変わらなければ保存し直さない", async () => {
    fake.files.set(DOCKERFILE_PATH, { sha: "d-1", content: CONTENT });
    expect(await sync()).toBe("updated");
    expect(stored()).toEqual({
      content: CONTENT,
      sha: "d-1",
      path: DOCKERFILE_PATH,
    });
    expect(readStoredWorkerDockerfile(db, REPO)).toEqual({
      path: DOCKERFILE_PATH,
      sha: "d-1",
      content: CONTENT,
    });
    expect(storedWorkerDockerfileSha(db, REPO)).toBe("d-1");
    expect(logged).toEqual([
      { level: "info", event: "product.dockerfile_updated" },
    ]);

    // 2回目は、知っている sha を渡し、何も変えない。
    expect(await sync()).toBe("unchanged");
    expect(fileCalls().at(-1)).toMatchObject({
      path: DOCKERFILE_PATH,
      knownSha: "d-1",
    });
    expect(logged).toEqual([]);

    fake.files.set(DOCKERFILE_PATH, { sha: "d-2", content: `${CONTENT}#\n` });
    expect(await sync()).toBe("updated");
    expect(storedWorkerDockerfileSha(db, REPO)).toBe("d-2");
  });

  it("ファイルがなければ、本文を消し、使おうとすると原因の分かるメッセージで失敗する", async () => {
    fake.files.set(DOCKERFILE_PATH, { sha: "d-1", content: CONTENT });
    await sync();
    fake.files.delete(DOCKERFILE_PATH);

    expect(await sync()).toBe("missing");
    expect(stored()).toEqual({
      content: null,
      sha: null,
      path: DOCKERFILE_PATH,
    });
    expect(logged).toEqual([
      { level: "warn", event: "product.dockerfile_missing" },
    ]);
    expect(storedWorkerDockerfileSha(db, REPO)).toBeNull();
    expect(() => readStoredWorkerDockerfile(db, REPO)).toThrow(
      `worker.dockerfile: ${DOCKERFILE_PATH})を使えません`,
    );

    // 同じ状態が続いている間は、ログを重ねない。
    expect(await sync()).toBe("missing");
    expect(logged).toEqual([]);
  });

  it("大きすぎるファイルは保存しない", async () => {
    fake.files.set(DOCKERFILE_PATH, {
      sha: "d-big",
      content: "#".repeat(MAX_DOCKERFILE_BYTES + 1),
    });
    expect(await sync()).toBe("too_large");
    expect(stored()).toEqual({
      content: null,
      sha: "d-big",
      path: DOCKERFILE_PATH,
    });
    expect(logged).toEqual([
      { level: "warn", event: "product.dockerfile_too_large" },
    ]);
    expect(storedWorkerDockerfileSha(db, REPO)).toBeNull();
    expect(() => readStoredWorkerDockerfile(db, REPO)).toThrow("を使えません");
    // 同じ内容のままなら、取得し直さない。
    expect(await sync()).toBe("unchanged");
  });

  it("factory.yml のパスが変わったら、前の本文を使わず、新しい場所から取得し直す", async () => {
    fake.files.set(DOCKERFILE_PATH, { sha: "d-1", content: CONTENT });
    await sync();
    const moved = WITH_DOCKERFILE.replace(DOCKERFILE_PATH, "other/Dockerfile");

    // 新しい場所にファイルがない間は、前の本文を使わない。
    expect(await sync(moved)).toBe("missing");
    expect(fileCalls().at(-1)).toMatchObject({
      path: "other/Dockerfile",
      knownSha: null,
    });
    expect(() => readStoredWorkerDockerfile(db, REPO)).toThrow("を使えません");

    fake.files.set("other/Dockerfile", { sha: "d-1", content: CONTENT });
    expect(await sync(moved)).toBe("updated");
    expect(readStoredWorkerDockerfile(db, REPO)?.path).toBe("other/Dockerfile");
  });

  it("factory.yml から消えたら、保存してあるものも消す", async () => {
    fake.files.set(DOCKERFILE_PATH, { sha: "d-1", content: CONTENT });
    await sync();
    expect(await sync(VALID_FACTORY_YML)).toBe("none");
    expect(stored()).toEqual({ content: null, sha: null, path: null });
    expect(logged).toEqual([
      { level: "info", event: "product.dockerfile_removed" },
    ]);
    // factory.yml が不正になった場合も、同じ。
    await sync();
    expect(await sync("version: 2\n")).toBe("none");
    expect(storedWorkerDockerfileSha(db, REPO)).toBeNull();
  });

  it("取得に失敗したら、保存してあるものを変えずに、失敗を伝える", async () => {
    fake.files.set(DOCKERFILE_PATH, { sha: "d-1", content: CONTENT });
    await sync();
    fake.failWith = new Error("network down");
    await expect(
      syncWorkerDockerfile({ db, api: fake, repo: REPO, logger }),
    ).rejects.toThrow("network down");
    expect(storedWorkerDockerfileSha(db, REPO)).toBe("d-1");
  });
});
