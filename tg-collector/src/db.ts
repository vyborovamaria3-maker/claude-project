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
  // Migrations are additive and idempotent. All writers must apply both before processing messages.
  for (const name of ["001_init.sql", "002_analytics.sql", "003_graph_rollups.sql", "004_runtime_restrictions.sql"]) {
    const sql = await readFile(new URL("../sql/" + name, import.meta.url), "utf8");
    await pool.query(sql);
  }
}
