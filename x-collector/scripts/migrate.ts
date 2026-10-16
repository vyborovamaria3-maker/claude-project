import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { assertMigrationCatalog } from "../lib/trade/migration-catalog";
import { REQUIRED } from "../lib/trade/migrations";
import { auditAppliedMigrationChecksums, migrationChecksum, type AppliedMigrationChecksum } from "../lib/trade/migration-checksum";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const LOCK_KEY = "x-collector:migrate";

async function main() {
  const statusOnly = process.argv.includes("--status");
  const baselineChecksums = process.argv.includes("--baseline-checksums");
  if (statusOnly && baselineChecksums) {
    throw new Error("--status and --baseline-checksums cannot be used together");
  }

  // Validate the complete SQL inventory before opening a database connection.
  const migrationFiles = await fs.readdir(MIGRATIONS_DIR);
  assertMigrationCatalog(migrationFiles);
  const sqlFiles = migrationFiles.filter(filename => filename.endsWith(".sql"));
  const sqlByFilename = new Map<string, string>();
  for (const filename of sqlFiles) {
    sqlByFilename.set(filename, await fs.readFile(path.join(MIGRATIONS_DIR, filename), "utf8"));
  }
  const checksumByFilename = new Map<string, string>();
  for (const [filename, sql] of sqlByFilename) {
    checksumByFilename.set(filename, migrationChecksum(sql));
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 2, application_name: "x-collector-migrate" });
  const lockClient = await pool.connect();
  try {
    // Сессионный advisory lock: два параллельных migrate не применят файл дважды.
    const acquired = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::BIGINT) AS locked`, [LOCK_KEY]
    );
    if (acquired.rows[0]?.locked !== true) {
      throw new Error("Другой процесс уже выполняет миграции; повторный запуск отклонён");
    }
    try {
      if (statusOnly) {
        const exists = await pool.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
        if (exists.rows[0]?.present !== true) {
          for (const filename of REQUIRED) console.log("[pending] " + filename);
          return;
        }
        const checksumColumn = await pool.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'schema_migrations' AND column_name = 'checksum') AS present"
        );
        const appliedRows: AppliedMigrationChecksum[] = checksumColumn.rows[0]?.present
          ? (await pool.query<AppliedMigrationChecksum>("SELECT filename, checksum FROM schema_migrations")).rows
          : (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(row => ({ filename: row.filename, checksum: null }));
        const audit = auditAppliedMigrationChecksums(appliedRows, checksumByFilename);
        if (audit.errors.length) throw new Error("Migration checksum audit failed: " + audit.errors.join("; "));
        const appliedByName = new Map(appliedRows.map(row => [row.filename, row]));
        for (const filename of REQUIRED) {
          const row = appliedByName.get(filename);
          if (!row) console.log("[pending] " + filename);
          else if (row.checksum === null) console.log("[baseline required] " + filename);
          else console.log("[applied] " + filename);
        }
        if (audit.needsBaseline.length) {
          console.warn("Legacy migration checksums require explicit baseline: " + audit.needsBaseline.join(", "));
        }
        return;
      }

      await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      // Upgrade the historical two-column ledger without silently blessing it.
      await pool.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
      const appliedRows = (await pool.query<AppliedMigrationChecksum>("SELECT filename, checksum FROM schema_migrations")).rows;
      const audit = auditAppliedMigrationChecksums(appliedRows, checksumByFilename);
      if (audit.errors.length) throw new Error("Migration checksum audit failed: " + audit.errors.join("; "));

      if (baselineChecksums) {
        if (audit.needsBaseline.length === 0) {
          await pool.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
          console.log("No legacy checksums require baseline; no migrations were applied.");
          return;
        }
        await lockClient.query("BEGIN");
        try {
          for (const filename of audit.needsBaseline) {
            const checksum = checksumByFilename.get(filename);
            if (!checksum) throw new Error("Cannot baseline migration without current SQL file: " + filename);
            const updated = await lockClient.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum IS NULL",
              [filename, checksum],
            );
            if (updated.rowCount !== 1) throw new Error("Migration ledger changed during checksum baseline: " + filename);
          }
          const remaining = await lockClient.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM schema_migrations WHERE checksum IS NULL"
          );
          if (remaining.rows[0]?.count !== "0") throw new Error("Checksum baseline left legacy rows without checksums");
          await lockClient.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
          await lockClient.query("COMMIT");
          console.log("Baselined checksums for " + audit.needsBaseline.length + " applied migration(s). No pending migrations were run.");
        } catch (error) {
          await lockClient.query("ROLLBACK").catch(() => {});
          throw error;
        }
        return;
      }

      if (audit.needsBaseline.length) {
        throw new Error(
          "Applied migrations have no checksum. Review the current SQL files and backup, then run " +
          "'npm run migrate -- --baseline-checksums' once; this pins current files and cannot detect edits made before the baseline. " +
          "Missing checksums: " + audit.needsBaseline.join(", "),
        );
      }
      await pool.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
      const applied = new Set(appliedRows.map(row => row.filename));
      for (const filename of REQUIRED) {
        if (applied.has(filename)) continue;
        const sql = sqlByFilename.get(filename);
        const checksum = checksumByFilename.get(filename);
        if (sql === undefined || checksum === undefined) throw new Error("Migration SQL unavailable after preflight: " + filename);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)", [filename, checksum]);
          await client.query("COMMIT");
          console.log("Applied " + filename);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1)::BIGINT)`, [LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[x-collector:migrate]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
