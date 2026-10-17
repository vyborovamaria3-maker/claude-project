import "dotenv/config";
import { assertMigrationChecksum, migrationChecksum } from "./migration-checksum.js";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required. Create tg-collector/.env");

export const pool = new pg.Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

type MigrationRow = { name: string; checksum: string };

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize migration runners before inspecting the migration ledger.
    await client.query("SELECT pg_advisory_xact_lock(8260225)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_by TEXT NOT NULL DEFAULT current_user
      )
    `);
    const directory = new URL("../sql/", import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
      .sort((a, b) => a.localeCompare(b, "en"));
    const applied = await client.query<MigrationRow>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    const checksums = new Map(applied.rows.map((row) => [row.name, row.checksum.trim()]));

    for (const name of names) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = migrationChecksum(sql);
      const existing = checksums.get(name);
      if (existing) {
        assertMigrationChecksum(name, existing, checksum);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)",
        [name, checksum]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
