import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required. Create tg-collector/.env");

export const pool = new pg.Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Synchronize migrations from worker, CLI, and web smoke scripts.
    await client.query("SELECT pg_advisory_xact_lock(8260225)");
    for (const name of ["001_init.sql", "002_analytics.sql", "003_graph_rollups.sql", "004_runtime_restrictions.sql", "005_source_metrics.sql", "006_text_search.sql", "007_message_counters.sql"]) {
      const sql = await readFile(new URL("../sql/" + name, import.meta.url), "utf8");
      await client.query(sql);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
