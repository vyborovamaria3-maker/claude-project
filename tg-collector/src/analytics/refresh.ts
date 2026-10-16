import "dotenv/config";
import { pool, migrate } from "../db.js";

/** Explicit offline rebuild for existing rows, or after manual DB deletions.
 * Stop the live worker first; advisory lock prevents concurrent ingestion. */
async function main(): Promise<void> {
  await migrate();
  const guard = await pool.connect();
  try {
    const result = await guard.query<{acquired: boolean}>(
      "SELECT pg_try_advisory_lock(8260226) AS acquired"
    );
    if (!result.rows[0]?.acquired) throw Error("Stop TG Collector worker before rebuilding graph cache");
    await guard.query("BEGIN");
    try {
      await guard.query("DELETE FROM tg_graph_daily_edges");
      await guard.query("DELETE FROM tg_source_daily_metrics");
      await guard.query(`
        INSERT INTO tg_graph_daily_edges
          (source_id,day,kind,target_kind,target_key,evidence_count,message_count,first_seen,last_seen,sample_message_id)
        SELECT l.source_id,(m.posted_at AT TIME ZONE 'UTC')::date,
          l.kind,l.target_kind,l.target_key,
          count(*)::integer,count(DISTINCT l.message_id)::integer,min(m.posted_at),max(m.posted_at),min(l.message_id)
        FROM tg_message_links l
        JOIN tg_messages m USING(source_id,message_id)
        WHERE m.posted_at IS NOT NULL AND m.deleted_at IS NULL
        GROUP BY l.source_id,(m.posted_at AT TIME ZONE 'UTC')::date,l.kind,l.target_kind,l.target_key
      `);
      await guard.query(`
        INSERT INTO tg_source_daily_metrics(source_id,day,posts_count,views_total,views_count)
        SELECT source_id,(posted_at AT TIME ZONE 'UTC')::date,
          count(*)::integer,coalesce(sum(views),0)::bigint,count(views)::integer
        FROM tg_messages WHERE posted_at IS NOT NULL AND deleted_at IS NULL
        GROUP BY source_id,(posted_at AT TIME ZONE 'UTC')::date
      `);
      await guard.query("COMMIT");
    } catch (error) {
      await guard.query("ROLLBACK");
      throw error;
    }
    console.log("Graph daily aggregates rebuilt from evidence.");
  } finally {
    try { await guard.query("SELECT pg_advisory_unlock(8260226)"); }
    finally { guard.release(); await pool.end(); }
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
