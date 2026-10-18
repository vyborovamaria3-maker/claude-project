import { migrationChecksum, validateMigrations, MigrationChecksumMismatch, type Migration } from "./migrations.js";

/** Structural interfaces: caller supplies its existing pg Pool, no new pool or driver. */
export type PgClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
  release(): void;
};
export type PgPool = { connect(): Promise<PgClient> };

export type MigrationResult = { applied: string[]; unchanged: string[] };

/**
 * All migrations run under one advisory transaction lock on the provided
 * PostgreSQL connection. Never run against legacy X manifests until their
 * ordering/checksums are explicitly reconciled.
 */
export async function migratePostgres(
  pool: PgPool,
  migrations: readonly Migration[],
  advisoryLockId = 75264170,
): Promise<MigrationResult> {
  const list = validateMigrations(migrations);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    // Detect changed or removed previously applied migrations before writing.
    const recorded = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    const current = new Map(list.map(m => [m.name, migrationChecksum(m.sql)]));
    for (const row of recorded.rows) {
      if (!current.has(row.name)) throw new Error("Applied migration missing from manifest: " + row.name);
      if (current.get(row.name) !== row.checksum) throw new MigrationChecksumMismatch(row.name);
    }

    const applied: string[] = [];
    const unchanged: string[] = [];
    const previous = new Set(recorded.rows.map(row => row.name));
    const maxApplied = recorded.rows.reduce((max, row) => row.name > max ? row.name : max, "");
    for (const migration of list) {
      if (previous.has(migration.name)) { unchanged.push(migration.name); continue; }
      if (migration.name <= maxApplied) throw new Error("Out-of-order migration: " + migration.name);
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)", [
        migration.name, migrationChecksum(migration.sql),
      ]);
      applied.push(migration.name);
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return { applied, unchanged };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* original error wins */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
