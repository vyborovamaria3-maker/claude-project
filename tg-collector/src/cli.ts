import "dotenv/config";
import { pool, migrate } from "./db.js";
import { login } from "./telegram.js";
import { normalizePublicUsername } from "./validation.js";


async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "login") {
    await migrate();
    await login();
    // A new verified session resolves revoked credentials, but not an account-level restriction.
    await pool.query("UPDATE tg_runtime SET block_reason=NULL, blocked_at=NULL WHERE id=1 AND block_reason='TG_SESSION_INVALID'");
    return;
  }
  if (action === "unblock") {
    if (process.argv[3] !== "--i-confirm-restriction-cleared") {
      throw new Error("Review Telegram account status first; then: npx tsx src/cli.ts unblock --i-confirm-restriction-cleared");
    }
    await pool.query("UPDATE tg_runtime SET block_reason=NULL,blocked_at=NULL WHERE id=1");
    console.log("Manual unblock recorded. No accounts were rotated.");
    return;
  }
  if (action === "migrate") { await migrate(); console.log("TG schema migrated"); return; }
  if (action === "add") {
    const identifier = normalizePublicUsername(process.argv[3] || "");
    const fullHistory = process.argv.includes("--full");
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tg_sources(identifier,full_history,history_partial) VALUES ($1,$2,$2)
         ON CONFLICT(identifier) DO UPDATE SET enabled=TRUE,
           full_history=tg_sources.full_history OR EXCLUDED.full_history,
           history_partial=CASE WHEN tg_sources.history_complete THEN FALSE ELSE
             tg_sources.history_partial OR EXCLUDED.full_history END
         RETURNING id`,
        [identifier,fullHistory]
      );
      await tx.query(
        `INSERT INTO tg_jobs(source_id) VALUES ($1)
         ON CONFLICT (source_id) DO NOTHING`,
        [rows[0].id]
      );
      await tx.query(`UPDATE tg_jobs SET state='pending',attempts=0,run_at=now(),
        locked_until=NULL,last_error=NULL,
        base_message_id=NULL,high_message_id=NULL,cursor_before_id=NULL,scanned_count=0
        WHERE source_id=$1 AND state IN ('pending','failed')`, [rows[0].id]);
      await tx.query("COMMIT");
      console.log("Added source:", identifier, fullHistory ? "(full history)" : "(recent messages)");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
    return;
  }
  if (action === "history") {
    const identifier = normalizePublicUsername(process.argv[3] || "");
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const source = await tx.query<{id:string}>(`SELECT s.id::text AS id FROM tg_sources s
        JOIN tg_jobs j ON j.source_id=s.id
        WHERE s.identifier=$1 AND j.state<>'running'
        FOR UPDATE OF s,j`,[identifier]);
      if(!source.rowCount) throw Error("Source not found or sync currently running");
      await tx.query(`UPDATE tg_sources SET full_history=TRUE,history_complete=FALSE,
        history_partial=TRUE,enabled=TRUE WHERE id=$1`,[source.rows[0].id]);
      await tx.query(`UPDATE tg_jobs SET state='pending',attempts=0,run_at=now(),
        base_message_id=NULL,high_message_id=NULL,cursor_before_id=NULL,
        scanned_count=0,locked_until=NULL,last_error=NULL,updated_at=now()
        WHERE source_id=$1 AND state IN ('pending','failed')`,[source.rows[0].id]);
      await tx.query("COMMIT");
      console.log("Historical scan queued:",identifier);
    } catch (error) {await tx.query("ROLLBACK");throw error;} finally {tx.release();}
    return;
  }
  if (action === "list") {
    const { rows } = await pool.query(
      `SELECT s.identifier, s.title, s.last_message_id, s.history_partial,
              s.last_success_at, s.full_history,s.history_complete,s.history_low_message_id,j.state, j.run_at, j.last_error
         FROM tg_sources s LEFT JOIN tg_jobs j ON j.source_id=s.id
        ORDER BY s.id`
    );
    console.table(rows);
    return;
  }
  throw new Error("Usage: npm run migrate | npm run login | npm run add -- @channel [--full] | npm run history -- @channel | npm run list");
}
main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode=1; })
  .finally(() => pool.end());
