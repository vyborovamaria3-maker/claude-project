import type { PoolClient } from "pg";

export interface ObservedXTweet {
  id: string;
  authorId?: string | null;
  observedAt?: number;
  postedAt: number | null;
}

/** Opt-in source-side ingestion only; the laptop's normal X worker remains unchanged. */
export function xIntelligenceOutboxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.X_INTELLIGENCE_OUTBOX_ENABLED === "true";
}

export function buildXTweetOutboxEvent(
  tweet: ObservedXTweet,
  collectionTimeMs: number,
) {
  if (!/^\d{15,25}$/.test(tweet.id)) throw new TypeError("Invalid tweet ID");
  // An X handle is NOT a stable identity. Lack of authorId is explicitly
  // unresolvable until backfill; never identify by authorHandle.
  if (typeof tweet.authorId !== "string" || !/^[1-9]\d{0,24}$/.test(tweet.authorId)) {
    return null;
  }
  const observedMs=tweet.observedAt ?? collectionTimeMs;
  if (!Number.isSafeInteger(observedMs) || observedMs<0 ||
      observedMs>8_640_000_000_000_000) throw new TypeError("Invalid observedAt");
  const observedAt=new Date(observedMs).toISOString();
  const hasPublished=tweet.postedAt!==null &&
    Number.isSafeInteger(tweet.postedAt) && tweet.postedAt >= 0 &&
    tweet.postedAt <= 8_640_000_000_000_000;
  const occurredAt=hasPublished ? new Date(tweet.postedAt!).toISOString():observedAt;
  const eventKey=`x:tweet:${tweet.id}:observed:${observedMs}`;
  const evidenceRef={
    sourceKind:"x_tweet",sourceId:`x:tweet:${tweet.id}`,
    observedAt,occurredAt,parserVersion:"x-collector-v1",
  };
  const entityRefs=[{
    kind:"author",canonicalId:`x:${tweet.authorId}`,
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  }];
  return {
    sourceSystem:"x",eventKind:"tweet_observed",eventKey,
    schemaVersion:"x-tweet-v1",
    payload:{
      registryEvent:{
        sourceSystem:"x",eventKind:"tweet_observed",eventKey,
        schemaVersion:"x-tweet-v1",entityRefs,evidenceRef,
      },
      timelineEvent:{
        schemaVersion:"timeline-v1",eventKey,kind:"tweet_published",
        occurredAt,observedAt,entityRefs,evidenceRef,payload:{},
      },
    },
  };
}

/** Pass the SAME PG client in the existing tweet+archive transaction. */
export async function emitXTweetOutbox(
  client: PoolClient,tweet: ObservedXTweet,collectionTimeMs:number,
):Promise<boolean> {
  if (!xIntelligenceOutboxEnabled()) return false;
  const event=buildXTweetOutboxEvent(tweet,collectionTimeMs);
  if (!event) return false;
  await client.query(`INSERT INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(source_system,event_kind,event_key) DO NOTHING`,[
      event.sourceSystem,event.eventKind,event.eventKey,
      event.schemaVersion,JSON.stringify(event.payload),
    ]);
  return true;
}
