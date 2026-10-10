import type { PoolClient } from "pg";
import { link } from "../trade/intelligence-store";

type Client = Pick<PoolClient, "query">;

export type CrossChainReason = "SHARED_RAW_EVENT" | "SHARED_METADATA";

export type CrossChainCandidate = {
  sourceEntityId: string;
  targetEntityId: string;
  sourceChain: string;
  targetChain: string;
  rawEventId: string | null;
  reason: CrossChainReason;
  confidence: number;
};

export class MissingEvidenceError extends Error {
  constructor(readonly candidate: CrossChainCandidate) {
    super(
      `Cross-chain link ${candidate.sourceEntityId} -> ${candidate.targetEntityId} requires an existing raw event`,
    );
    this.name = "MissingEvidenceError";
  }
}

const SHARED_RAW_EVENT_SQL = `
WITH involved AS (
  SELECT raw_event_id, chain, from_entity AS entity_id
  FROM ip_blockchain_transactions WHERE from_entity IS NOT NULL
  UNION ALL
  SELECT raw_event_id, chain, to_entity AS entity_id
  FROM ip_blockchain_transactions WHERE to_entity IS NOT NULL
),
pairs AS (
  SELECT a.raw_event_id, a.entity_id AS source_entity_id, b.entity_id AS target_entity_id
  FROM involved a
  JOIN involved b ON a.raw_event_id = b.raw_event_id
                 AND a.entity_id < b.entity_id
                 AND a.chain <> b.chain
)
SELECT p.raw_event_id, p.source_entity_id, p.target_entity_id,
       s.platform AS source_chain, t.platform AS target_chain
FROM pairs p
JOIN ip_entities s ON s.id = p.source_entity_id AND s.type = 'WALLET'
JOIN ip_entities t ON t.id = p.target_entity_id AND t.type = 'WALLET' AND s.platform <> t.platform
ORDER BY p.source_entity_id, p.target_entity_id`;

const SHARED_METADATA_SQL = `
WITH wallets AS (
  SELECT e.id, e.platform, e.metadata,
         (SELECT t.raw_event_id FROM ip_blockchain_transactions t
          WHERE t.from_entity = e.id OR t.to_entity = e.id
          ORDER BY t.timestamp DESC NULLS LAST LIMIT 1) AS raw_event_id
  FROM ip_entities e
  WHERE e.type = 'WALLET'
)
SELECT a.id AS source_entity_id, b.id AS target_entity_id,
       a.platform AS source_chain, b.platform AS target_chain,
       COALESCE(a.raw_event_id, b.raw_event_id) AS raw_event_id
FROM wallets a
JOIN wallets b ON a.id < b.id AND a.platform <> b.platform
WHERE a.metadata <> '{}'::jsonb AND a.metadata = b.metadata
ORDER BY a.id, b.id`;

type RawCandidate = {
  raw_event_id: string | null;
  source_entity_id: string;
  target_entity_id: string;
  source_chain: string;
  target_chain: string;
};

export async function findCrossChainCandidates(c: Client): Promise<CrossChainCandidate[]> {
  const sharedEvent = await c.query<RawCandidate>(SHARED_RAW_EVENT_SQL);
  const sharedMetadata = await c.query<RawCandidate>(SHARED_METADATA_SQL);
  const byPair = new Map<string, CrossChainCandidate>();
  const push = (row: RawCandidate, reason: CrossChainReason, confidence: number) => {
    const key = `${row.source_entity_id}|${row.target_entity_id}`;
    const next: CrossChainCandidate = {
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      sourceChain: row.source_chain,
      targetChain: row.target_chain,
      rawEventId: row.raw_event_id,
      reason,
      confidence,
    };
    const current = byPair.get(key);
    if (!current || current.confidence < next.confidence) byPair.set(key, next);
  };
  for (const row of sharedEvent.rows) push(row, "SHARED_RAW_EVENT", 1);
  for (const row of sharedMetadata.rows) push(row, "SHARED_METADATA", 0.5);
  return [...byPair.values()].sort((a, b) =>
    a.sourceEntityId === b.sourceEntityId
      ? a.targetEntityId.localeCompare(b.targetEntityId)
      : a.sourceEntityId.localeCompare(b.sourceEntityId),
  );
}

export async function linkCrossChain(c: Client, candidate: CrossChainCandidate): Promise<string> {
  if (!candidate.rawEventId) throw new MissingEvidenceError(candidate);
  const raw = await c.query<{ collected_at: Date }>(
    `SELECT collected_at FROM ip_raw_events WHERE id = $1`,
    [candidate.rawEventId],
  );
  if (!raw.rows[0]) throw new MissingEvidenceError(candidate);
  return link(
    c,
    candidate.sourceEntityId,
    candidate.targetEntityId,
    "CONNECTED_BY_PATTERN",
    candidate.rawEventId,
    new Date(raw.rows[0].collected_at),
    candidate.confidence,
  );
}
