import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/office/clock.ts";
import { currentVersion, type Db, migrate, openDb } from "../src/office/db.ts";

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock = clockAt("2026-01-02T03:04:05.000Z");

const EXPECTED_TABLES = [
  "decisions",
  "events",
  "issues",
  "reports",
  "repos",
  "runs",
  "schedules",
  "schema_version",
  "steps",
];

function tableNames(db: Db): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function schemaDump(db: Db): unknown {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all();
}

describe("マイグレーション", () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-db-"));
    dbPath = path.join(dir, "factory.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const backups = () =>
    fs.readdirSync(dir).filter((file) => file.includes(".bak-"));

  const writeMigrations = (files: Record<string, string>): string => {
    const migrationsDir = path.join(dir, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      fs.writeFileSync(path.join(migrationsDir, name), sql);
    }
    return migrationsDir;
  };

  it("空のDBに適用できる", () => {
    const result = migrate(db, { clock });

    expect(result.applied).toEqual([1, 2, 3, 4]);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
    expect(currentVersion(db)).toBe(4);
  });

  it("実行中の実行とステップの重複を防ぐ索引がある", () => {
    migrate(db, { clock });
    const indexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
      )
      .all();
    expect(indexes).toEqual([
      { name: "runs_one_running_per_issue", tbl_name: "runs" },
      { name: "steps_one_running_per_run", tbl_name: "steps" },
    ]);
  });

  it("steps に、中断した呼び出しのログの場所を残す列がある", () => {
    migrate(db, { clock });
    const columns = db.pragma("table_info(steps)") as { name: string }[];
    expect(columns.map((column) => column.name)).toContain(
      "interrupted_log_paths",
    );
  });

  it("状態を持つテーブルはリポジトリの列を持つ", () => {
    migrate(db, { clock });
    for (const table of [
      "repos",
      "issues",
      "events",
      "decisions",
      "runs",
      "schedules",
      "reports",
    ]) {
      const columns = db.pragma(`table_info(${table})`) as { name: string }[];
      expect(
        columns.map((column) => column.name),
        table,
      ).toContain("repo");
    }
  });

  it("2回実行しても変わらない", () => {
    migrate(db, { clock });
    const before = schemaDump(db);
    const backupsBefore = backups();

    const second = migrate(db, { clock: clockAt("2026-01-02T03:05:00.000Z") });

    expect(second).toEqual({ applied: [], backupPath: null });
    expect(schemaDump(db)).toEqual(before);
    expect(currentVersion(db)).toBe(4);
    expect(backups()).toEqual(backupsBefore);
  });

  it("未適用があるときは、適用前の内容で複製が作られる", () => {
    const migrationsDir = writeMigrations({
      "001_first.sql": "CREATE TABLE first (id INTEGER PRIMARY KEY, v TEXT);",
    });
    migrate(db, { migrationsDir, clock });
    db.prepare("INSERT INTO first (v) VALUES ('kept')").run();

    writeMigrations({
      "002_second.sql": "ALTER TABLE first ADD COLUMN w TEXT;",
    });
    const result = migrate(db, {
      migrationsDir,
      clock: clockAt("2026-01-02T03:05:00.000Z"),
    });

    expect(result.applied).toEqual([2]);
    expect(result.backupPath).not.toBeNull();
    const backup = new Database(result.backupPath as string, {
      readonly: true,
    });
    try {
      expect(currentVersion(backup)).toBe(1);
      expect(backup.prepare("SELECT v FROM first").all()).toEqual([
        { v: "kept" },
      ]);
      const columns = backup.pragma("table_info(first)") as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(["id", "v"]);
    } finally {
      backup.close();
    }
  });

  it("失敗したら元に戻る", () => {
    const migrationsDir = writeMigrations({
      "001_first.sql": "CREATE TABLE first (id INTEGER PRIMARY KEY);",
      "002_broken.sql":
        "CREATE TABLE second (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1);",
    });

    expect(() => migrate(db, { migrationsDir, clock })).toThrow(
      /002_broken\.sql/,
    );

    expect(currentVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual(["first", "schema_version"]);
  });

  it("失敗の原因を直すと、続きから適用できる", () => {
    const migrationsDir = writeMigrations({
      "001_first.sql": "CREATE TABLE first (id INTEGER PRIMARY KEY);",
      "002_second.sql": "THIS IS NOT SQL;",
    });
    expect(() => migrate(db, { migrationsDir, clock })).toThrow();

    writeMigrations({
      "002_second.sql": "CREATE TABLE second (id INTEGER PRIMARY KEY);",
    });
    const result = migrate(db, {
      migrationsDir,
      clock: clockAt("2026-01-02T03:05:00.000Z"),
    });

    expect(result.applied).toEqual([2]);
    expect(tableNames(db)).toEqual(["first", "schema_version", "second"]);
  });

  it("番号が連番でなければ失敗する", () => {
    const migrationsDir = writeMigrations({
      "001_first.sql": "CREATE TABLE first (id INTEGER PRIMARY KEY);",
      "003_third.sql": "CREATE TABLE third (id INTEGER PRIMARY KEY);",
    });
    expect(() => migrate(db, { migrationsDir, clock })).toThrow(/連番/);
  });

  it("DBの版が手元のマイグレーションより新しければ失敗する", () => {
    migrate(db, { clock });
    db.prepare("UPDATE schema_version SET version = 99").run();
    expect(() => migrate(db, { clock })).toThrow(/新しい/);
  });
});
