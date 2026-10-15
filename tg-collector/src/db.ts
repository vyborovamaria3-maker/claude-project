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
  const sql = await readFile(new URL("../sql/001_init.sql", import.meta.url), "utf8");
  await pool.query(sql);
}
