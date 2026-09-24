import { q, q1 } from "./pg";

export async function listMintEvents(mint: string, limit = 50) {
  return q(`SELECT * FROM mint_events WHERE mint = $1 ORDER BY detected_at DESC LIMIT $2`, [mint, limit]);
}

export async function listMintMilestones(mint: string) {
  return q(`SELECT milestone, value, reached_at FROM mint_milestones WHERE mint = $1 ORDER BY reached_at`, [mint]);
}

export async function getFirstMovers(mint: string) {
  return q1(`SELECT * FROM mv_mint_first_movers WHERE mint = $1`, [mint]);
}

export async function getMintTimeline(mint: string, limit = 100) {
  return q(`SELECT * FROM v_mint_timeline WHERE mint = $1 LIMIT $2`, [mint, limit]);
}

export async function addMintEvent(params: {
  mint: string; eventType: string; severity?: number; eventAt?: number;
  payload?: unknown; source?: string; notes?: string;
}) {
  const now = Date.now();
  await q(
    `INSERT INTO mint_events (mint, event_type, severity, detected_at, event_at, payload, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [params.mint, params.eventType, params.severity ?? 1, now,
     params.eventAt ?? now, JSON.stringify(params.payload ?? {}),
     params.source ?? "manual", params.notes ?? null]
  );
}

export async function detectViral(): Promise<number> {
  const r = await q<{ detect_viral_events: number }>(`SELECT detect_viral_events()`);
  return r[0]?.detect_viral_events ?? 0;
}

export async function getMintFirstVerified(mint: string) {
  return q1(
    `SELECT handle, first_mention_at FROM (
       SELECT l.handle, t.posted_at AS first_mention_at,
              ROW_NUMBER() OVER (ORDER BY t.posted_at) AS rn
       FROM tweet_token_links l
       JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
       WHERE l.mint = $1 AND t.is_verified = TRUE AND t.posted_at IS NOT NULL
     ) x WHERE rn = 1`, [mint]
  );
}

