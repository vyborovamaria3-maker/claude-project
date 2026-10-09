export interface Observation {
  tweetId: string; handle: string; postedAt: number;
  entities: string[]; influence: number;
}
export interface GraphSignal {
  entity: string; tweets: number; authors: number; previousTweets: number;
  relatedEntities: number; baseScore: number; graphImpact: number;
  authorInfluence: number; score: number;
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

/** Equal adjacent windows; only observed posts contribute, never future data. */
export function analyzeGraphSignals(observations: Observation[], now: number, windowMs = 3_600_000): GraphSignal[] {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("now and windowMs must be safe integers; windowMs must be positive");
  }
  const current = new Map<string, { tweets: Set<string>; authors: Map<string, number>; related: Set<string> }>();
  const previous = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const post of observations) {
    if (seen.has(post.tweetId) || !Number.isFinite(post.postedAt) || post.postedAt > now || post.postedAt <= now - 2 * windowMs) continue;
    seen.add(post.tweetId);
    const entities = [...new Set(post.entities.filter(Boolean))].sort();
    for (const entity of entities) {
      if (post.postedAt <= now - windowMs) {
        const tweets = previous.get(entity) ?? new Set<string>();
        tweets.add(post.tweetId); previous.set(entity, tweets); continue;
      }
      const stats = current.get(entity) ?? { tweets: new Set<string>(), authors: new Map<string, number>(), related: new Set<string>() };
      stats.tweets.add(post.tweetId);
      const author = post.handle.toLowerCase().replace(/^@/, "");
      const influence = Number.isFinite(post.influence) ? Math.max(0, Math.min(100, post.influence)) : 0;
      stats.authors.set(author, Math.max(stats.authors.get(author) ?? 0, influence));
      for (const other of entities) if (other !== entity) stats.related.add(other);
      current.set(entity, stats);
    }
  }
  return [...current].map(([entity, stats]): GraphSignal => {
    const tweets = stats.tweets.size, authors = stats.authors.size;
    const previousTweets = previous.get(entity)?.size ?? 0;
    const growth = previousTweets === 0 ? Math.min(tweets / 5, 1) : Math.max(0, Math.min((tweets - previousTweets) / previousTweets, 1));
    const baseScore = Math.min(tweets / 20, 1) * 30 + growth * 30 + Math.min(authors / 10, 1) * 20 + Math.min(tweets / (windowMs / 60_000) / 2, 1) * 20;
    const authorInfluence = [...stats.authors.values()].reduce((a, b) => a + b, 0) / Math.max(authors, 1);
    const graphImpact = Math.min(authors / 10, 1) * 70 + Math.min(stats.related.size / 10, 1) * 30;
    const score = Math.round((baseScore * 0.6 + authorInfluence * 0.25 + graphImpact * 0.15) * 100) / 100;
    const level = score >= 80 ? "CRITICAL" : score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW";
    return { entity, tweets, authors, previousTweets, relatedEntities: stats.related.size, baseScore, graphImpact, authorInfluence, score, level };
  }).sort((a, b) => b.score - a.score || a.entity.localeCompare(b.entity));
}
