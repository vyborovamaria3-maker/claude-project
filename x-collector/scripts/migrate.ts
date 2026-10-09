import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
import { REQUIRED } from "../lib/trade/migrations";
const LOCK_KEY = "x-collector:migrate";

async function main() {
  const statusOnly = process.argv.includes("--status");

  const available = new Set(await fs.readdir(MIGRATIONS_DIR));
  const missing = REQUIRED.filter((name) => !available.has(name));
  if (missing.length) {
    throw new Error(
      "Migration chain is incomplete; no database changes were made. Missing: " +
      missing.join(", ") +
      ". Restore the missing migration file(s) before migrating.",
    );
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
        const applied = new Set(exists.rows[0]?.present
          ? (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(r => r.filename)
          : []);
        for (const filename of REQUIRED) {
          console.log(`${applied.has(filename) ? "[applied]" : "[pending]"} ${filename}`);
        }
        return;
      }

      await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");

      for (const filename of REQUIRED) {
        const alreadyApplied = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
        if (alreadyApplied.rowCount) continue;
        const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
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
