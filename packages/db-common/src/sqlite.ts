import { migrationChecksum, validateMigrations, MigrationChecksumMismatch, type Migration } from "./migrations.js";
import type { MigrationResult } from "./postgres.js";

/** Compatible with the existing better-sqlite3 Database, without opening it. */
export type SqliteDb = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

/** BEGIN IMMEDIATE obtains SQLite's writer lock before reading migration state. */
export function migrateSqlite(db: SqliteDb, migrations: readonly Migration[]): MigrationResult {
  const list = validateMigrations(migrations);
  db.exec("BEGIN IMMEDIATE");
  let open = true;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const recorded = db.prepare("SELECT name, checksum FROM schema_migrations ORDER BY name")
      .all() as { name: string; checksum: string }[];
    const current = new Map(list.map(m => [m.name, migrationChecksum(m.sql)]));
    for (const row of recorded) {
      if (!current.has(row.name)) throw new Error("Applied migration missing from manifest: " + row.name);
      if (current.get(row.name) !== row.checksum) throw new MigrationChecksumMismatch(row.name);
    }

    const applied: string[] = [];
    const unchanged: string[] = [];
    const previous = new Set(recorded.map(row => row.name));
    const maxApplied = recorded.reduce((max, row) => row.name > max ? row.name : max, "");
    const insert = db.prepare("INSERT INTO schema_migrations(name,checksum,applied_at) VALUES (?,?,?)");
    for (const migration of list) {
      if (previous.has(migration.name)) { unchanged.push(migration.name); continue; }
      if (migration.name <= maxApplied) throw new Error("Out-of-order migration: " + migration.name);
      db.exec(migration.sql);
      insert.run(migration.name, migrationChecksum(migration.sql), new Date().toISOString());
      applied.push(migration.name);
    }
    db.exec("COMMIT");
    open = false;
    return { applied, unchanged };
  } catch (error) {
    if (open) {
      try { db.exec("ROLLBACK"); } catch { /* preserve first error */ }
    }
    throw error;
  }
}
