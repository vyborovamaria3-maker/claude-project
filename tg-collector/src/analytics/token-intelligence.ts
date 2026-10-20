import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ANALYSIS_VERSION, type MessageLink, type RawTelegramMessage } from "./extract.js";
import { syncTokenNarratives } from "./narratives.js";

export const SOLANA_CHAIN_ID = "solana-mainnet";
export const CHANNEL_SCORE_VERSION = "channel-score-v1";
export const OUTCOME_VERSION = "market-outcome-v1";
const TICKER_PATTERN = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

export function extractTickerMentions(text: string): string[] {
  return [...new Set([...text.matchAll(TICKER_PATTERN)].map((match) => match[1].toUpperCase()))].sort();
}

export function normalizeMessageForFingerprint(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, " <url> ")
    .replace(/(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/gi, " <evm> ")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, " <solana-address> ")
    .replace(/\$[a-z][a-z0-9]{1,9}\b/gi, " <ticker> ")
    .replace(/@[a-z][a-z0-9_]{4,31}\b/gi, " <handle> ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

export function fingerprintMessage(text: string): { fingerprint: string; normalizedLength: number; clusterable: boolean } {
  const normalized = normalizeMessageForFingerprint(text);
  return {
    fingerprint: createHash("sha256").update(normalized).digest("hex"),
    normalizedLength: normalized.length,
    clusterable: normalized.length >= 40,
  };
}

/** Persist address/ticker candidates without assuming that a base58 address is a mint. */
export async function syncMessageTokenCandidates(
  tx: PoolClient, sourceId: string, msg: RawTelegramMessage, links: MessageLink[],
): Promise<void> {
  const addresses = [...new Set(links.filter((link) => link.targetKind === "solana_address").map((link) => link.targetKey))];
  const tickers = extractTickerMentions(msg.message ?? "");
  const messageDate = typeof msg.date === "number" ? new Date(msg.date * 1000) : null;
  const messageId = msg.id;

  await tx.query(
    "DELETE FROM tg_token_candidates WHERE source_id=$1 AND message_id=$2 AND analysis_version=$3 " +
    "AND ((candidate_type='address' AND NOT(candidate_key=ANY($4::text[]))) " +
    "OR (candidate_type='ticker' AND NOT(candidate_key=ANY($5::text[]))))",
    [sourceId, messageId, ANALYSIS_VERSION, addresses, tickers],
  );
  await tx.query(
    "DELETE FROM tg_ticker_mentions WHERE source_id=$1 AND message_id=$2 AND analysis_version=$3 " +
    "AND NOT(ticker=ANY($4::text[]))",
    [sourceId, messageId, ANALYSIS_VERSION, tickers],
  );

  for (const address of addresses) {
    await tx.query(
      "INSERT INTO tg_token_candidates " +
      "(source_id,message_id,chain_id,candidate_type,candidate_key,raw_value,analysis_version,extractor_name) " +
      "VALUES($1,$2,$3,'address',$4,$4,$5,'telegram-text') " +
      "ON CONFLICT(source_id,message_id,chain_id,candidate_type,candidate_key,analysis_version) " +
      "DO UPDATE SET raw_value=EXCLUDED.raw_value,last_seen_at=now(),extractor_name=EXCLUDED.extractor_name",
      [sourceId, messageId, SOLANA_CHAIN_ID, address, ANALYSIS_VERSION],
    );
  }

  for (const ticker of tickers) {
    await tx.query(
      "INSERT INTO tg_token_candidates " +
      "(source_id,message_id,chain_id,candidate_type,candidate_key,raw_value,analysis_version,extractor_name) " +
      "VALUES($1,$2,$3,'ticker',$4,$5,$6,'telegram-text') " +
      "ON CONFLICT(source_id,message_id,chain_id,candidate_type,candidate_key,analysis_version) " +
      "DO UPDATE SET raw_value=EXCLUDED.raw_value,last_seen_at=now(),extractor_name=EXCLUDED.extractor_name",
      [sourceId, messageId, SOLANA_CHAIN_ID, ticker, "$" + ticker, ANALYSIS_VERSION],
    );
    await tx.query(
      "INSERT INTO tg_ticker_mentions " +
      "(source_id,message_id,chain_id,ticker,raw_text,message_date,analysis_version,extractor_name) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,'telegram-text') " +
      "ON CONFLICT(source_id,message_id,chain_id,ticker,analysis_version) " +
      "DO UPDATE SET raw_text=EXCLUDED.raw_text,message_date=EXCLUDED.message_date,observed_at=now()",
      [sourceId, messageId, SOLANA_CHAIN_ID, ticker, "$" + ticker, messageDate, ANALYSIS_VERSION],
    );
    await tx.query(
      "INSERT INTO tg_ticker_registry(ticker,chain_id,mint,resolution_status,confidence,evidence_count) " +
      "VALUES($1,$2,NULL,'unresolved',0,0) ON CONFLICT DO NOTHING",
      [ticker, SOLANA_CHAIN_ID],
    );
    await tx.query(
      "UPDATE tg_ticker_registry r SET evidence_count=(" +
      "SELECT count(*) FROM tg_ticker_mentions tm WHERE tm.ticker=r.ticker AND tm.chain_id=r.chain_id)," +
      "last_seen_at=now() WHERE r.ticker=$1 AND r.chain_id=$2 AND r.mint IS NULL AND r.resolution_status='unresolved'",
      [ticker, SOLANA_CHAIN_ID],
    );
  }

  // A newer analysis version must reuse previously verified Solana mints.
  // Verified mint identity is blockchain metadata, not parser-version-specific;
  // reindexing historical posts must not trigger another paid RPC check.
  await tx.query(
    `UPDATE tg_token_candidates c
     SET resolution_status='confirmed_token',confidence=1,
       provider=COALESCE(c.provider,t.metadata_provider),checked_at=COALESCE(c.checked_at,now())
     FROM tg_tokens t
     WHERE c.source_id=$1 AND c.message_id=$2 AND c.analysis_version=$3
       AND c.chain_id=t.chain_id AND c.candidate_type='address'
       AND c.candidate_key=t.mint AND c.resolution_status<>'confirmed_token'`,
    [sourceId,messageId,ANALYSIS_VERSION],
  );
  await tx.query(
    `INSERT INTO tg_token_mentions
      (source_id,message_id,chain_id,mint,mention_type,resolution_status,
       confidence,message_date,analysis_version,extractor_name,orphaned)
     SELECT $1,$2,t.chain_id,t.mint,'mint','confirmed',1,$3,$4,'telegram-text',FALSE
     FROM tg_tokens t WHERE t.chain_id=$5 AND t.mint=ANY($6::text[])
     ON CONFLICT(source_id,message_id,chain_id,mint,mention_type,analysis_version)
       DO UPDATE SET orphaned=FALSE,resolution_status='confirmed',confidence=1`,
    [sourceId,messageId,messageDate,ANALYSIS_VERSION,SOLANA_CHAIN_ID,addresses],
  );
  // Reuse confirmed, unambiguous ticker-to-mint links from prior versions.
  // A ticker mapped to multiple mints must remain ambiguous.
  await tx.query(
    `INSERT INTO tg_token_mentions
      (source_id,message_id,chain_id,mint,mention_type,resolution_status,
       confidence,message_date,analysis_version,extractor_name,orphaned)
     SELECT $1,$2,reg.chain_id,min(reg.mint),'ticker','confirmed',
       min(reg.confidence),$3,$4,'telegram-text',FALSE
     FROM tg_ticker_registry reg
     WHERE reg.chain_id=$5 AND reg.ticker=ANY($6::text[])
       AND reg.mint IS NOT NULL AND reg.resolution_status='confirmed'
     GROUP BY reg.chain_id,reg.ticker HAVING count(DISTINCT reg.mint)=1
     ON CONFLICT(source_id,message_id,chain_id,mint,mention_type,analysis_version)
       DO UPDATE SET orphaned=FALSE`,
    [sourceId,messageId,messageDate,ANALYSIS_VERSION,SOLANA_CHAIN_ID,tickers],
  );

  await tx.query(
    "UPDATE tg_token_mentions tm SET orphaned=TRUE " +
    "WHERE tm.source_id=$1 AND tm.message_id=$2 AND tm.analysis_version=$3 AND (" +
    "(tm.mention_type='mint' AND NOT(tm.mint=ANY($4::text[]))) OR " +
    "(tm.mention_type='ticker' AND NOT EXISTS (" +
    "SELECT 1 FROM tg_ticker_mentions tick JOIN tg_ticker_registry reg " +
    "ON reg.ticker=tick.ticker AND reg.chain_id=tick.chain_id AND reg.mint=tm.mint " +
    "AND reg.resolution_status='confirmed' WHERE tick.source_id=tm.source_id " +
    "AND tick.message_id=tm.message_id AND tick.analysis_version=$3)))",
    [sourceId, messageId, ANALYSIS_VERSION, addresses],
  );
  if (addresses.length) {
    await tx.query(
      "UPDATE tg_token_mentions SET orphaned=FALSE WHERE source_id=$1 AND message_id=$2 " +
      "AND analysis_version=$3 AND mention_type='mint' AND mint=ANY($4::text[])",
      [sourceId, messageId, ANALYSIS_VERSION, addresses],
    );
  }
  await tx.query(
    "UPDATE tg_token_mentions tm SET orphaned=FALSE FROM tg_ticker_mentions tick,tg_ticker_registry reg " +
    "WHERE tm.source_id=$1 AND tm.message_id=$2 AND tm.analysis_version=$3 " +
    "AND tick.source_id=tm.source_id AND tick.message_id=tm.message_id AND tick.analysis_version=$3 " +
    "AND reg.ticker=tick.ticker AND reg.chain_id=tick.chain_id AND reg.mint=tm.mint " +
    "AND reg.resolution_status='confirmed' AND tm.mention_type='ticker'",
    [sourceId, messageId, ANALYSIS_VERSION],
  );

  const previousFingerprint = await tx.query<{cluster_id: string | null}>(
    "SELECT cluster_id::text FROM tg_message_fingerprints WHERE source_id=$1 AND message_id=$2 AND analysis_version=$3",
    [sourceId, messageId, ANALYSIS_VERSION],
  );
  const fingerprint = fingerprintMessage(msg.message ?? "");
  let clusterId: string | null = null;
  if (fingerprint.clusterable) {
    const cluster = await tx.query<{ id: string }>(
      "INSERT INTO tg_copy_clusters(fingerprint,method,analysis_version) VALUES($1,'normalized_exact',$2) " +
      "ON CONFLICT(fingerprint,method,analysis_version) DO UPDATE SET updated_at=now() RETURNING id::text",
      [fingerprint.fingerprint, ANALYSIS_VERSION],
    );
    clusterId = cluster.rows[0]?.id ?? null;
  }
  await tx.query(
    "INSERT INTO tg_message_fingerprints " +
    "(source_id,message_id,fingerprint,normalized_length,cluster_id,method,analysis_version) " +
    "VALUES($1,$2,$3,$4,$5,'normalized_exact',$6) " +
    "ON CONFLICT(source_id,message_id,analysis_version) DO UPDATE SET " +
    "fingerprint=EXCLUDED.fingerprint,normalized_length=EXCLUDED.normalized_length," +
    "cluster_id=EXCLUDED.cluster_id,method=EXCLUDED.method,computed_at=now()",
    [sourceId, messageId, fingerprint.fingerprint, fingerprint.normalizedLength, clusterId, ANALYSIS_VERSION],
  );
  const clusterIds = [...new Set([previousFingerprint.rows[0]?.cluster_id ?? null, clusterId].filter((id): id is string => Boolean(id)))];
  for (const id of clusterIds) {
    await tx.query(
      "UPDATE tg_copy_clusters SET member_count=(SELECT count(*) FROM tg_message_fingerprints " +
      "WHERE cluster_id=$1 AND analysis_version=$2),updated_at=now() WHERE id=$1",
      [id, ANALYSIS_VERSION],
    );
  }

  const similarityMethod = "normalized_exact_v" + ANALYSIS_VERSION;
  await tx.query(
    "DELETE FROM tg_message_similarity WHERE method=$3 AND " +
    "((source_a=$1 AND message_a=$2) OR (source_b=$1 AND message_b=$2))",
    [sourceId, messageId, similarityMethod],
  );
  if (clusterId) {
    const peers = await tx.query<{source_id: string; message_id: string}>(
      "SELECT source_id::text,message_id::text FROM tg_message_fingerprints " +
      "WHERE cluster_id=$1 AND analysis_version=$2 AND NOT(source_id=$3 AND message_id=$4) " +
      "ORDER BY source_id,message_id LIMIT 100",
      [clusterId, ANALYSIS_VERSION, sourceId, messageId],
    );
    for (const peer of peers.rows) {
      const peerFirst = BigInt(peer.source_id) < BigInt(sourceId) ||
        (BigInt(peer.source_id) === BigInt(sourceId) && BigInt(peer.message_id) < BigInt(messageId));
      const leftSource = peerFirst ? peer.source_id : sourceId;
      const leftMessage = peerFirst ? peer.message_id : String(messageId);
      const rightSource = peerFirst ? sourceId : peer.source_id;
      const rightMessage = peerFirst ? String(messageId) : peer.message_id;
      await tx.query(
        "INSERT INTO tg_message_similarity(source_a,message_a,source_b,message_b,similarity,method,model_version) " +
        "VALUES($1,$2,$3,$4,1,$5,$6) ON CONFLICT DO NOTHING",
        [leftSource, leftMessage, rightSource, rightMessage, similarityMethod, "copy-v" + ANALYSIS_VERSION],
      );
    }
  }
  await tx.query(
    "UPDATE tg_token_mentions SET copy_cluster_id=$3 " +
    "WHERE source_id=$1 AND message_id=$2 AND analysis_version=$4",
    [sourceId, messageId, clusterId, ANALYSIS_VERSION],
  );
  const resolvedMentions = await tx.query<{chain_id: string; mint: string; orphaned: boolean}>(
    "SELECT chain_id,mint,bool_and(orphaned) AS orphaned FROM tg_token_mentions " +
    "WHERE source_id=$1 AND message_id=$2 AND analysis_version=$3 GROUP BY chain_id,mint",
    [sourceId, messageId, ANALYSIS_VERSION],
  );
  for (const mention of resolvedMentions.rows) {
    await syncTokenNarratives(tx, sourceId, String(messageId), mention.chain_id, mention.mint,
      mention.orphaned ? "" : (msg.message ?? ""));
  }
}

/** Rebuild one source's day-level token/copy metrics after message writes or backfill. */
export async function refreshTokenChannelMetrics(tx: PoolClient, sourceId: string, days: string[]): Promise<void> {
  const unique = [...new Set(days)].filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day));
  if (!unique.length) return;
  await tx.query(
    "DELETE FROM tg_channel_metrics_daily WHERE source_id=$1 AND day=ANY($2::date[]) AND analysis_version=$3",
    [sourceId, unique, ANALYSIS_VERSION],
  );
  await tx.query(
    "WITH days AS (SELECT unnest($2::date[]) AS day), metrics AS (" +
    "SELECT d.day," +
    "(SELECT count(*)::integer FROM tg_messages m WHERE m.source_id=$1 AND m.deleted_at IS NULL " +
    "AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS messages_total," +
    "(SELECT count(DISTINCT c.candidate_key)::integer FROM tg_token_candidates c " +
    "JOIN tg_messages m USING(source_id,message_id) WHERE c.source_id=$1 AND c.candidate_type='address' " +
    "AND m.deleted_at IS NULL AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS address_candidates," +
    "(SELECT count(*)::integer FROM tg_ticker_mentions t JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE t.source_id=$1 AND m.deleted_at IS NULL AND t.analysis_version=$3 " +
    "AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS ticker_mentions," +
    "(SELECT count(*)::integer FROM tg_token_mentions t JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE t.source_id=$1 AND t.analysis_version=$3 AND t.orphaned=FALSE AND m.deleted_at IS NULL " +
    "AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS confirmed_token_mentions," +
    "(SELECT count(DISTINCT (t.chain_id,t.mint))::integer FROM tg_token_mentions t " +
    "JOIN tg_messages m USING(source_id,message_id) WHERE t.source_id=$1 AND t.analysis_version=$3 " +
    "AND t.orphaned=FALSE AND m.deleted_at IS NULL AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS unique_confirmed_tokens," +
    "(SELECT count(*)::integer FROM tg_token_first_mentions f WHERE f.source_id=$1 " +
    "AND (f.message_date AT TIME ZONE 'UTC')::date=d.day) AS first_mentions," +
    "(SELECT count(DISTINCT fp.cluster_id)::integer FROM tg_message_fingerprints fp " +
    "JOIN tg_messages m USING(source_id,message_id) WHERE fp.source_id=$1 AND fp.analysis_version=$3 " +
    "AND fp.cluster_id IS NOT NULL AND m.deleted_at IS NULL AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS unique_copy_clusters," +
    "(SELECT count(*)::integer FROM tg_message_fingerprints fp JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE fp.source_id=$1 AND fp.analysis_version=$3 AND fp.cluster_id IS NOT NULL AND m.deleted_at IS NULL " +
    "AND (m.posted_at AT TIME ZONE 'UTC')::date=d.day) AS clustered_messages FROM days d) " +
    "INSERT INTO tg_channel_metrics_daily(source_id,day,analysis_version,messages_total,address_candidates," +
    "ticker_mentions,confirmed_token_mentions,unique_confirmed_tokens,unique_token_discoveries,first_mentions," +
    "unique_copy_clusters,copypasta_ratio,computed_at) " +
    "SELECT $1,day,$3,messages_total,address_candidates,ticker_mentions,confirmed_token_mentions," +
    "unique_confirmed_tokens,first_mentions,first_mentions,unique_copy_clusters," +
    "CASE WHEN clustered_messages>0 THEN greatest(0,1-(unique_copy_clusters::numeric/clustered_messages)) ELSE NULL END,now() FROM metrics",
    [sourceId, unique, ANALYSIS_VERSION],
  );
}

/** Snapshot mention velocity from resolved tokens only; ticker-only guesses never become tokens. */
export async function refreshTokenVelocity(tx: PoolClient, now = new Date()): Promise<number> {
  const result = await tx.query(
    "WITH windows(window_name,span,seconds) AS (VALUES " +
    "('5m',interval '5 minutes',300),('15m',interval '15 minutes',900)," +
    "('1h',interval '1 hour',3600),('6h',interval '6 hours',21600),('24h',interval '24 hours',86400))," +
    "aggregates AS (SELECT tm.chain_id,tm.mint,w.window_name,date_trunc('minute',$1::timestamptz) AS window_start," +
    "$1::timestamptz AS computed_at,w.seconds,count(*)::integer AS mentions," +
    "count(DISTINCT tm.source_id)::integer AS unique_sources," +
    "count(DISTINCT NULLIF(m.sender_id,''))::integer AS unique_authors," +
    "count(DISTINCT COALESCE(fp.cluster_id::text,tm.source_id::text||':'||tm.message_id::text))::integer AS independent_clusters " +
    "FROM windows w JOIN tg_token_mentions tm ON tm.message_date >= $1::timestamptz-w.span " +
    "AND tm.message_date <= $1::timestamptz AND tm.analysis_version=$2 AND tm.orphaned=FALSE " +
    "JOIN tg_messages m USING(source_id,message_id) LEFT JOIN tg_message_fingerprints fp " +
    "ON fp.source_id=tm.source_id AND fp.message_id=tm.message_id AND fp.analysis_version=$2 " +
    "WHERE m.deleted_at IS NULL GROUP BY tm.chain_id,tm.mint,w.window_name,w.seconds) " +
    "INSERT INTO tg_token_velocity(chain_id,mint,window_name,window_start,mentions,unique_sources,unique_authors," +
    "independent_clusters,velocity,acceleration,z_score,computed_at) " +
    "SELECT a.chain_id,a.mint,a.window_name,a.window_start,a.mentions,a.unique_sources,a.unique_authors," +
    "a.independent_clusters,a.mentions::numeric/a.seconds," +
    "CASE WHEN previous.velocity IS NULL THEN NULL ELSE a.mentions::numeric/a.seconds-previous.velocity END," +
    "NULL,a.computed_at FROM aggregates a LEFT JOIN LATERAL (" +
    "SELECT v.velocity FROM tg_token_velocity v WHERE v.chain_id=a.chain_id AND v.mint=a.mint " +
    "AND v.window_name=a.window_name AND v.window_start<a.window_start ORDER BY v.window_start DESC LIMIT 1) previous ON TRUE " +
    "ON CONFLICT(chain_id,mint,window_name,window_start) DO UPDATE SET mentions=EXCLUDED.mentions," +
    "unique_sources=EXCLUDED.unique_sources,unique_authors=EXCLUDED.unique_authors," +
    "independent_clusters=EXCLUDED.independent_clusters,velocity=EXCLUDED.velocity," +
    "acceleration=EXCLUDED.acceleration,computed_at=EXCLUDED.computed_at",
    [now, ANALYSIS_VERSION],
  );
  return result.rowCount ?? 0;
}

function wilsonInterval(wins: number, total: number): { lower: number | null; upper: number | null } {
  if (total <= 0) return { lower: null, upper: null };
  const z = 1.96;
  const p = wins / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin) * 100, upper: Math.min(1, center + margin) * 100 };
}

/** Component scores are versioned; outcome/composite remain unavailable until data is sufficient. */
export async function refreshChannelScores(tx: PoolClient): Promise<number> {
  const result = await tx.query<{
    source_id: string; discoveries: string; confirmed_tokens: string; copy_ratio: string | null;
    outcome_count: string; wins: string; risk_events: string; risk_sample: string;
  }>(
    "SELECT s.id::text AS source_id," +
    "COALESCE((SELECT sum(d.unique_token_discoveries) FROM tg_channel_metrics_daily d WHERE d.source_id=s.id " +
    "AND d.analysis_version=$1 AND d.day>=current_date-29),0)::text AS discoveries," +
    "COALESCE((SELECT count(DISTINCT (tm.chain_id,tm.mint)) FROM tg_token_mentions tm JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE tm.source_id=s.id AND tm.analysis_version=$1 AND tm.orphaned=FALSE AND m.deleted_at IS NULL " +
    "AND tm.message_date>=now()-interval '30 days'),0)::text AS confirmed_tokens," +
    "(SELECT avg(d.copypasta_ratio)::text FROM tg_channel_metrics_daily d WHERE d.source_id=s.id " +
    "AND d.analysis_version=$1 AND d.day>=current_date-29) AS copy_ratio," +
    "(SELECT count(*)::text FROM tg_token_outcomes o JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE o.source_id=s.id AND o.model_version=$2 AND o.outcome_status IN ('complete','risk_confirmed') " +
    "AND o.price_at_mention>0 AND o.price_24h>0 AND m.deleted_at IS NULL " +
    "AND o.mention_time>=now()-interval '30 days') AS outcome_count," +
    "(SELECT count(*)::text FROM tg_token_outcomes o JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE o.source_id=s.id AND o.model_version=$2 AND o.outcome_status IN ('complete','risk_confirmed') " +
    "AND o.price_at_mention>0 AND o.price_24h>o.price_at_mention AND m.deleted_at IS NULL " +
    "AND o.mention_time>=now()-interval '30 days') AS wins," +
    "(SELECT count(*)::text FROM tg_token_outcomes o JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE o.source_id=s.id AND o.model_version=$2 AND o.risk_event=TRUE AND o.risk_assessed=TRUE AND m.deleted_at IS NULL " +
    "AND o.mention_time>=now()-interval '30 days') AS risk_events," +
    "(SELECT count(*)::text FROM tg_token_outcomes o JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE o.source_id=s.id AND o.model_version=$2 AND o.risk_assessed=TRUE AND m.deleted_at IS NULL " +
    "AND o.mention_time>=now()-interval '30 days') AS risk_sample " +
    "FROM tg_sources s ORDER BY s.id",
    [ANALYSIS_VERSION, OUTCOME_VERSION],
  );

  for (const row of result.rows) {
    const discoveries = Number(row.discoveries);
    const confirmed = Number(row.confirmed_tokens);
    const sample = Number(row.outcome_count);
    const wins = Number(row.wins);
    const riskEvents = Number(row.risk_events);
    const riskSample = Number(row.risk_sample);
    const copyRatio = row.copy_ratio === null ? null : Math.max(0, Math.min(1, Number(row.copy_ratio)));
    const discoveryScore = confirmed > 0 ? Math.min(100, discoveries / confirmed * 100) : null;
    const originalityScore = copyRatio === null ? null : (1 - copyRatio) * 100;
    const outcomeScore = sample > 0 ? (wins + 2.5) / (sample + 5) * 100 : null;
    const riskScore = riskSample > 0 ? (riskEvents + 1) / (riskSample + 2) * 100 : null;
    const composite = sample >= 5 && discoveryScore !== null && originalityScore !== null && riskScore !== null && outcomeScore !== null
      ? discoveryScore * 0.35 + outcomeScore * 0.35 + originalityScore * 0.2 + (100 - riskScore) * 0.1 : null;
    const interval = wilsonInterval(wins, sample);
    await tx.query(
      "INSERT INTO tg_channel_scores(source_id,model_version,discovery_score,outcome_score,originality_score," +
      "risk_score,composite_score,sample_size,confidence_lower,confidence_upper,features) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
      [row.source_id, CHANNEL_SCORE_VERSION, discoveryScore, outcomeScore, originalityScore, riskScore, composite,
       sample, interval.lower, interval.upper, JSON.stringify({ discoveries30d: discoveries,
         confirmedTokens30d: confirmed, copyRatio30d: copyRatio, outcomes30d: sample, wins24h: wins,
         riskEvents30d: riskEvents, riskAssessedOutcomes30d: riskSample, compositeRequiresAtLeastFiveOutcomes: true })],
    );
  }
  return result.rows.length;
}


/** Detect exact-copy propagation across several sources; this is a review signal, not proof of coordination. */
export async function detectPropagationPatterns(tx: PoolClient, chainId: string, mint: string): Promise<number> {
  const result = await tx.query(
    "WITH patterns AS (" +
    "SELECT tm.chain_id,tm.mint,fp.cluster_id,min(tm.message_date) AS window_start,max(tm.message_date) AS window_end," +
    "array_agg(DISTINCT tm.source_id ORDER BY tm.source_id) AS source_ids," +
    "count(DISTINCT tm.source_id)::integer AS source_count,count(DISTINCT (tm.source_id,tm.message_id))::integer AS message_count " +
    "FROM tg_token_mentions tm JOIN tg_messages m USING(source_id,message_id) " +
    "JOIN tg_message_fingerprints fp ON fp.source_id=tm.source_id AND fp.message_id=tm.message_id " +
    "AND fp.analysis_version=tm.analysis_version " +
    "WHERE tm.chain_id=$1 AND tm.mint=$2 AND tm.analysis_version=$3 AND tm.orphaned=FALSE " +
    "AND m.deleted_at IS NULL AND tm.message_date>=now()-interval '24 hours' AND fp.cluster_id IS NOT NULL " +
    "GROUP BY tm.chain_id,tm.mint,fp.cluster_id " +
    "HAVING count(DISTINCT tm.source_id)>=3 AND max(tm.message_date)-min(tm.message_date)<=interval '10 minutes') " +
    "INSERT INTO tg_coordination_events(chain_id,mint,cluster_id,source_ids,window_start,window_end," +
    "similarity_score,confidence,evidence,model_version) " +
    "SELECT chain_id,mint,cluster_id,source_ids,window_start,window_end,1.0," +
    "least(0.75,0.45+source_count*0.05),jsonb_build_object(" +
    "'pattern','normalized_exact_copy','source_count',source_count,'message_count',message_count," +
    "'interpretation','similarity is observable; coordination is unproven'), 'copy-propagation-v1' FROM patterns " +
    "ON CONFLICT(chain_id,mint,cluster_id,window_start,model_version) WHERE cluster_id IS NOT NULL " +
    "DO UPDATE SET source_ids=EXCLUDED.source_ids,window_end=EXCLUDED.window_end," +
    "confidence=EXCLUDED.confidence,evidence=EXCLUDED.evidence,detected_at=now()",
    [chainId, mint, ANALYSIS_VERSION],
  );
  return result.rowCount ?? 0;
}

/** Create reproducible observations; these are discovery/risk review items, not trade orders. */
export async function refreshSignals(tx: PoolClient): Promise<number> {
  const firstMentions = await tx.query(
    "INSERT INTO tg_signals(signal_type,chain_id,mint,source_id,message_id,detected_at,confidence,features,model_version) " +
    "SELECT 'first_observed_mint_mention',f.chain_id,f.mint,f.source_id,f.message_id,COALESCE(f.message_date,f.observed_at)," +
    "CASE WHEN f.coverage_status='partial_source_history' THEN 0.60 ELSE 0.70 END," +
    "jsonb_build_object('interpretation','earliest mention in collected history','coverage_status',f.coverage_status)," +
    "'first-mention-v1' FROM tg_token_first_mentions f " +
    "JOIN tg_messages m ON m.source_id=f.source_id AND m.message_id=f.message_id AND m.deleted_at IS NULL " +
    "ON CONFLICT DO NOTHING",
  );
  const velocitySignals = await tx.query(
    "INSERT INTO tg_signals(signal_type,chain_id,mint,source_id,message_id,confidence,features,model_version) " +
    "SELECT 'cross_channel_velocity_spike',v.chain_id,v.mint,NULL,NULL," +
    "least(0.95,0.50+least(v.unique_sources,10)*0.02+least(v.independent_clusters,10)*0.01)," +
    "jsonb_build_object('window','5m','mentions',v.mentions,'unique_sources',v.unique_sources," +
    "'independent_clusters',v.independent_clusters,'interpretation','candidate signal requiring review')," +
    "'velocity-v1' FROM tg_token_velocity v WHERE v.window_name='5m' AND v.mentions>=5 " +
    "AND v.unique_sources>=3 AND v.independent_clusters>=3 " +
    "AND v.window_start=(SELECT max(v2.window_start) FROM tg_token_velocity v2 " +
    "WHERE v2.chain_id=v.chain_id AND v2.mint=v.mint AND v2.window_name=v.window_name) " +
    "ON CONFLICT DO NOTHING",
  );
  return (firstMentions.rowCount ?? 0) + (velocitySignals.rowCount ?? 0);
}


/** Recompute earliest observed mention from the active analysis version and collected history. */
export async function refreshTokenFirstMentions(tx: PoolClient): Promise<number> {
  await tx.query(
    "DELETE FROM tg_token_first_mentions f WHERE NOT EXISTS (" +
    "SELECT 1 FROM tg_token_mentions tm JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE tm.chain_id=f.chain_id AND tm.mint=f.mint AND tm.analysis_version=$1 " +
    "AND tm.orphaned=FALSE AND m.deleted_at IS NULL)",
    [ANALYSIS_VERSION],
  );
  const result = await tx.query(
    "WITH firsts AS (SELECT DISTINCT ON (tm.chain_id,tm.mint) tm.chain_id,tm.mint,tm.source_id,tm.message_id," +
    "tm.message_date,tm.observed_at,tm.analysis_version,s.history_partial " +
    "FROM tg_token_mentions tm JOIN tg_messages m USING(source_id,message_id) " +
    "JOIN tg_sources s ON s.id=tm.source_id WHERE tm.analysis_version=$1 AND tm.orphaned=FALSE AND m.deleted_at IS NULL " +
    "ORDER BY tm.chain_id,tm.mint,tm.message_date ASC NULLS LAST,tm.observed_at,tm.source_id,tm.message_id) " +
    "INSERT INTO tg_token_first_mentions(chain_id,mint,source_id,message_id,message_date,observed_at,coverage_status,analysis_version,calculated_at) " +
    "SELECT chain_id,mint,source_id,message_id,message_date,observed_at," +
    "CASE WHEN history_partial THEN 'partial_source_history' ELSE 'collected_source_history' END,analysis_version,now() FROM firsts " +
    "ON CONFLICT(chain_id,mint) DO UPDATE SET source_id=EXCLUDED.source_id,message_id=EXCLUDED.message_id," +
    "message_date=EXCLUDED.message_date,observed_at=EXCLUDED.observed_at,coverage_status=EXCLUDED.coverage_status," +
    "analysis_version=EXCLUDED.analysis_version,calculated_at=now()",
    [ANALYSIS_VERSION],
  );
  return result.rowCount ?? 0;
}
