import { q, q1 } from "./pg";

export async function rebuildAuthorReputation(): Promise<number> {
  const r = await q<{ rebuild_author_reputation: number }>(`SELECT rebuild_author_reputation()`);
  return r[0]?.rebuild_author_reputation ?? 0;
}

export async function rebuildAuthorBehavior(): Promise<number> {
  const r = await q<{ rebuild_author_behavior: number }>(`SELECT rebuild_author_behavior()`);
  return r[0]?.rebuild_author_behavior ?? 0;
}

export async function getAuthorReputation(handle: string) {
  return q1(`SELECT * FROM author_reputation WHERE handle = $1`, [handle.toLowerCase()]);
}

export async function getTopKOLs(limit = 50, minReputation = 60) {
  return q(
    `SELECT r.handle, r.reputation_score, r.tier, r.total_mints,
            r.avg_views, r.engagement_rate, r.is_verified
     FROM author_reputation r
     WHERE r.reputation_score >= $1
     ORDER BY r.reputation_score DESC, r.avg_views DESC LIMIT $2`,
    [minReputation, limit]
  );
}

export async function getSuspiciousAuthors(limit = 100) {
  return q(`SELECT * FROM v_suspicious_authors LIMIT $1`, [limit]);
}

export async function getAuthorBehavior(handle: string) {
  return q1(`SELECT * FROM author_behavior WHERE handle = $1`, [handle.toLowerCase()]);
}

export async function getKOLsForMint(mint: string, minReputation = 50) {
  return q(
    `SELECT a.handle, a.total_views, a.tweets_count, a.is_verified,
            r.reputation_score, r.tier
     FROM mv_author_token_stats a
     LEFT JOIN author_reputation r ON r.handle = a.handle
     WHERE a.mint = $1 AND COALESCE(r.reputation_score, 50) >= $2
     ORDER BY a.total_views DESC`, [mint, minReputation]
  );
}

