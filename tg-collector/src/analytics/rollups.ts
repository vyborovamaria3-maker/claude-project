import type { PoolClient } from "pg";

/** All analytics day buckets are UTC and based on Telegram posted_at, never DB insertion time. */
export function utcDay(date: Date | null | undefined): string | null {
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Replaces aggregates for explicitly changed days, in the same transaction as evidence updates. */
export async function refreshGraphDays(tx: PoolClient, sourceId: string, days: string[]): Promise<void> {
  const unique = [...new Set(days)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!unique.length) return;
  await tx.query(
    "DELETE FROM tg_graph_daily_edges WHERE source_id=$1 AND day = ANY($2::date[])",
    [sourceId, unique]
  );
  await tx.query(`
    INSERT INTO tg_graph_daily_edges
      (source_id,day,kind,target_kind,target_key,evidence_count,first_seen,last_seen,sample_message_id)
    SELECT l.source_id, (m.posted_at AT TIME ZONE 'UTC')::date AS day,
      l.kind,l.target_kind,l.target_key,
      count(*)::integer, min(m.posted_at), max(m.posted_at), min(l.message_id)
    FROM tg_message_links l
    JOIN tg_messages m USING (source_id,message_id)
    WHERE l.source_id=$1
      AND (m.posted_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
    GROUP BY l.source_id,(m.posted_at AT TIME ZONE 'UTC')::date,
      l.kind,l.target_kind,l.target_key`, [sourceId, unique]);
}
