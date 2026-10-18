import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { assertMigrationCatalog } from "../lib/trade/migration-catalog";
import { runMigrations } from "../lib/trade/migration-integrity";
import { REQUIRED } from "../lib/trade/migrations";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const LOCK_KEY = "x-collector:migrate";

async function main() {
  const statusOnly = process.argv.includes("--status");

  // Validate the complete SQL inventory before opening a database connection.
  assertMigrationCatalog(await fs.readdir(MIGRATIONS_DIR));

  const files = await Promise.all(REQUIRED.map(async filename => ({filename,sql:await fs.readFile(path.join(MIGRATIONS_DIR,filename),"utf8")})));
  const baseline = process.argv.includes("--baseline-checksums");
  if(statusOnly && baseline)throw new Error("Cannot combine --status and --baseline-checksums");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 1, application_name: "x-collector-migrate" });
  const lockClient = await pool.connect().catch(async error => {await pool.end();throw error;});
  lockClient.on("error", () => {});
  try {
    // Сессионный advisory lock: два параллельных migrate не применят файл дважды.
    const acquired = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::BIGINT) AS locked`, [LOCK_KEY]
    );
    if (acquired.rows[0]?.locked !== true) {
      throw new Error("Другой процесс уже выполняет миграции; повторный запуск отклонён");
    }
    try {
      await runMigrations(lockClient,files,{statusOnly,baseline,log:console.log});
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
