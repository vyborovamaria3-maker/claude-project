import { createHash } from "node:crypto";

export type Migration = Readonly<{ name: string; sql: string }>;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Only new names are allowed: historical edited migrations are never replayed. */
export function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const result = [...migrations];
  const names = new Set<string>();
  for (const migration of result) {
    if (!/^[0-9]{3,}_[a-z0-9][a-z0-9_-]*\.sql$/.test(migration.name)) {
      throw new Error("Invalid migration filename: " + migration.name);
    }
    if (names.has(migration.name)) throw new Error("Duplicate migration: " + migration.name);
    if (typeof migration.sql !== "string" || !migration.sql.trim()) {
      throw new Error("Empty migration: " + migration.name);
    }
    names.add(migration.name);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export class MigrationChecksumMismatch extends Error {
  constructor(public readonly migrationName: string) {
    super("MIGRATION_CHECKSUM_MISMATCH: " + migrationName);
    this.name = "MigrationChecksumMismatch";
  }
}
