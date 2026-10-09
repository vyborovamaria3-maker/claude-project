import type { PoolClient } from "pg";
import { tx } from "./pg";
import { advisoryKey } from "./advisory";
import { analyzeGraphSignals, type Observation } from "./graph-signals";

export interface CycleResult { acquired: boolean; signals: number; events: number; bucketAt: number }

/** Lock, snapshot and writes share one transaction and one connection. */
export async function executeMonitoringCycle(client: Pick<PoolClient, "query">, now: number, windowMs = 3_600_000): Promise<CycleResult> {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("Invalid monitoring window");
  const bucketAt = Math.floor(now / windowMs) * windowMs;
  const result: CycleResult = { acquired: false, signals: 0, events: 0, bucketAt };
  const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [advisoryKey("x-collector:graph-monitoring")]);
  if (!lock.rows[0]?.locked) return result;
  result.acquired = true;
  // Analyze completed windows: retries use precisely the same cutoff.
  const rows = await client.query<{ tweet_id: string; handle: string; posted_at: string; entities: string[]; influence: string }>(`
    SELECT t.tweet_id, t.handle, t.posted_at, COALESCE(r.reputation_score, 0)::text AS influence,
      ARRAY(SELECT DISTINCT 'entity:' || e.entity_type || ':' || e.value FROM tweet_entities e WHERE e.tweet_id=t.tweet_id AND COALESCE(e.confidence,0) >= 0.5
            UNION SELECT 'token:' || l.mint FROM tweet_token_links l WHERE l.tweet_id=t.tweet_id) AS entities
    FROM twitter_tweets t LEFT JOIN author_reputation r ON r.handle=t.handle
    WHERE t.posted_at > $1 AND t.posted_at <= $2 ORDER BY t.posted_at, t.tweet_id`, [bucketAt - 2 * windowMs, bucketAt]);
  const observations: Observation[] = rows.rows.map(row => ({ tweetId: row.tweet_id, handle: row.handle, postedAt: Number(row.posted_at), entities: row.entities, influence: Number(row.influence) }));
  const signals = analyzeGraphSignals(observations, bucketAt, windowMs);
  for (const signal of signals) {
    const inserted = await client.query(`INSERT INTO graph_signal_history(entity,bucket_at,window_ms,score,level,payload,created_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING RETURNING entity`,
      [signal.entity, bucketAt, windowMs, signal.score, signal.level, JSON.stringify(signal), now]);
    result.signals += inserted.rowCount ?? 0;
    if (signal.level === "HIGH" || signal.level === "CRITICAL") {
      // Derive events from persisted history, including after a retry.
      const event = await client.query(`INSERT INTO graph_priority_events(entity,bucket_at,window_ms,priority,payload,created_at)
        SELECT entity,bucket_at,window_ms,CASE WHEN level='CRITICAL' THEN 3 ELSE 2 END,payload,$4
        FROM graph_signal_history WHERE entity=$1 AND bucket_at=$2 AND window_ms=$3 AND level IN ('HIGH','CRITICAL')
        ON CONFLICT DO NOTHING RETURNING id`, [signal.entity, bucketAt, windowMs, now]);
      result.events += event.rowCount ?? 0;
    }
  }
  return result;
}

export function runMonitoringCycle(now = Date.now(), windowMs = 3_600_000): Promise<CycleResult> {
  return tx(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return executeMonitoringCycle(client, now, windowMs);
  });
}
