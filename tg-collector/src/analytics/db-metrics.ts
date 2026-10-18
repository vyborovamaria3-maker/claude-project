import "dotenv/config";
import { pool, migrate } from "../db.js";

/** Store approximate PostgreSQL table-growth metrics without scanning table contents. */
async function main(): Promise<void> {
  await migrate();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO tg_db_metrics_snapshots(captured_at,table_name,row_count,size_bytes,index_size_bytes) " +
      "SELECT now(),s.relname,greatest(s.n_live_tup,0)::bigint,pg_total_relation_size(s.relid)::bigint," +
      "pg_indexes_size(s.relid)::bigint FROM pg_stat_user_tables s " +
      "WHERE s.schemaname=current_schema() AND s.relname LIKE 'tg_%' " +
      "ON CONFLICT(captured_at,table_name) DO NOTHING"
    );
    await client.query("DELETE FROM tg_db_metrics_snapshots WHERE captured_at < now()-interval '180 days'");
    const latest = await client.query(
      "SELECT table_name,row_count,size_bytes,index_size_bytes FROM tg_db_metrics_snapshots " +
      "WHERE captured_at=(SELECT max(captured_at) FROM tg_db_metrics_snapshots) ORDER BY size_bytes DESC LIMIT 20"
    );
    await client.query("COMMIT");
    console.table(latest.rows);
    console.log("Row counts are PostgreSQL statistics estimates; sizes are measured bytes.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; })
  .finally(() => pool.end());
