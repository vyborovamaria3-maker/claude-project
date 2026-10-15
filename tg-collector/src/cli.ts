import "dotenv/config";
import { pool, migrate } from "./db.js";
import { login } from "./telegram.js";
import { normalizePublicUsername } from "./validation.js";


async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "login") { await login(); return; }
  if (action === "migrate") { await migrate(); console.log("TG schema migrated"); return; }
  if (action === "add") {
    const identifier = normalizePublicUsername(process.argv[3] || "");
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const { rows } = await tx.query<{ id: string }>(
        "INSERT INTO tg_sources(identifier) VALUES ($1) ON CONFLICT(identifier) DO UPDATE SET enabled=TRUE RETURNING id",
        [identifier]
      );
      await tx.query(
        `INSERT INTO tg_jobs(source_id) VALUES ($1)
         ON CONFLICT (source_id) DO NOTHING`,
        [rows[0].id]
      );
      await tx.query(`UPDATE tg_jobs SET state='pending', attempts=0, run_at=now(),
        locked_until=NULL, last_error=NULL
        WHERE source_id=$1 AND state IN ('pending','failed','delayed')`, [rows[0].id]);
      await tx.query("COMMIT");
      console.log("Added source:", identifier);
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
    return;
  }
  if (action === "list") {
    const { rows } = await pool.query(
      `SELECT s.identifier, s.title, s.last_message_id, s.history_partial,
              s.last_success_at, j.state, j.run_at, j.last_error
         FROM tg_sources s LEFT JOIN tg_jobs j ON j.source_id=s.id
        ORDER BY s.id`
    );
    console.table(rows);
    return;
  }
  throw new Error("Usage: npm run migrate | npm run login | npm run add -- @channel | npm run list");
}
main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode=1; })
  .finally(() => pool.end());
