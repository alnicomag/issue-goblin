import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type Clock, isoNow } from "./clock.ts";

export type Db = Database.Database;

/** リポジトリ直下の migrations/ ディレクトリ。 */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../migrations",
);

export interface Migration {
  readonly version: number;
  readonly file: string;
  readonly sql: string;
}

export interface MigrateResult {
  /** 今回適用したマイグレーションの番号。 */
  readonly applied: readonly number[];
  /** 適用前に作ったDBの複製。未適用がなかった場合と、メモリ上のDBでは null。 */
  readonly backupPath: string | null;
}

/** DBを開く。親ディレクトリがなければ作る。 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * migrations/ の連番のSQLファイルを読む。
 * ファイル名は `001_name.sql` の形式で、番号は1から抜けなく続くこと。
 */
export function loadMigrations(dir: string): Migration[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`マイグレーションのディレクトリがありません: ${dir}`);
  }
  const migrations = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = /^(\d+)_.+\.sql$/.exec(file);
      if (!match?.[1]) {
        throw new Error(
          `マイグレーションのファイル名が不正です(例: 001_init.sql): ${file}`,
        );
      }
      return {
        version: Number.parseInt(match[1], 10),
        file,
        sql: fs.readFileSync(path.join(dir, file), "utf8"),
      };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `マイグレーションの番号は1からの連番にしてください: ${migration.file} は ${index + 1} 番目です`,
      );
    }
  });
  return migrations;
}

/** 適用済みの最大の番号。何も適用していなければ 0。 */
export function currentVersion(db: Db): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
  );
  const rows = db.prepare("SELECT version FROM schema_version").all() as {
    version: number;
  }[];
  if (rows.length === 0) {
    db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    return 0;
  }
  const [row] = rows;
  if (rows.length > 1 || row === undefined) {
    throw new Error(
      `schema_version の行数が不正です(1行のはずが ${rows.length} 行)`,
    );
  }
  return row.version;
}

/**
 * 未適用のマイグレーションだけを順に適用する。起動のたびに呼んでよい。
 *
 * - 未適用のものがあれば、適用前にDBファイルを複製する。
 * - 1ファイルを1トランザクションで適用し、失敗したらそのファイルの変更を元に戻して例外を投げる。
 */
export function migrate(
  db: Db,
  options: { migrationsDir?: string; clock: Clock },
): MigrateResult {
  const migrations = loadMigrations(
    options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
  );
  const current = currentVersion(db);
  const latest = migrations.length;
  if (current > latest) {
    throw new Error(
      `DBの版(${current})が、手元のマイグレーション(${latest})より新しいです。古いコードで起動していませんか`,
    );
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) {
    return { applied: [], backupPath: null };
  }

  const backupPath = backupDb(db, current, options.clock);

  const applied: number[] = [];
  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("UPDATE schema_version SET version = ?").run(
        migration.version,
      );
    });
    try {
      apply();
    } catch (error) {
      throw new Error(
        `マイグレーション ${migration.file} の適用に失敗しました。このファイルの変更は元に戻しました`,
        { cause: error },
      );
    }
    applied.push(migration.version);
  }
  return { applied, backupPath };
}

/** DBファイルの複製を、同じディレクトリに作る。メモリ上のDBでは何もしない。 */
function backupDb(db: Db, version: number, clock: Clock): string | null {
  if (db.memory) return null;
  const stamp = isoNow(clock).replace(/[-:.]/g, "");
  const backupPath = `${db.name}.bak-v${version}-${stamp}`;
  if (fs.existsSync(backupPath)) {
    throw new Error(`DBの複製先がすでにあります: ${backupPath}`);
  }
  // WALの内容も含めた一貫した複製を作る。
  db.prepare("VACUUM INTO ?").run(backupPath);
  return backupPath;
}
