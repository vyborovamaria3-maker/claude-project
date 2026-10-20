import {
  buildTimelineEvent, parseTokenId, toUtcIso,
  type TimelineEvent, type TokenId,
} from "@claude-project/contracts";
import { validateRegistryEvent, type PgTransaction, type RegistryEvent } from "./entity-registry.js";

/** Timeline inserts REQUIRE inbox + entity registry to already exist in the same destination transaction. */
export async function ingestTimelineEvent(
  tx: PgTransaction,
  sourceSystem: RegistryEvent["sourceSystem"],
  sourceEventKind: string,
  input: TimelineEvent,
): Promise<boolean> {
  const source = validateRegistryEvent({
    sourceSystem, eventKind: sourceEventKind, eventKey: input.eventKey,
    schemaVersion: input.schemaVersion, entityRefs: input.entityRefs,
    evidenceRef: input.evidenceRef,
  });
  const event = buildTimelineEvent({
    eventKey: input.eventKey, kind: input.kind,
    occurredAt: input.occurredAt, observedAt: input.observedAt,
    entityRefs: source.entityRefs, evidenceRef: source.evidenceRef, payload: input.payload,
  });
  if (event.observedAt !== source.evidenceRef.observedAt) {
    throw new TypeError("Timeline observedAt must equal source evidence observedAt");
  }

  const inserted = await tx.query(`INSERT INTO timeline_events
    (source_system,source_event_kind,event_key,timeline_kind,occurred_at,observed_at,
     evidence_source_id,schema_version,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT (source_system,source_event_kind,event_key) DO NOTHING
    RETURNING event_key`, [
    sourceSystem,sourceEventKind,event.eventKey,event.kind,event.occurredAt,
    event.observedAt,event.evidenceRef.sourceId,event.schemaVersion,
    JSON.stringify(event.payload),
  ]);
  if (inserted.rows.length === 0) {
    // A duplicate key is only idempotent if EVERY persisted timeline field
    // and the exact entity membership agree. Inbox identity alone is insufficient.
    const previous=await tx.query("SELECT event_key FROM timeline_events " +
      "WHERE source_system=$1 AND source_event_kind=$2 AND event_key=$3 " +
      "AND timeline_kind=$4 AND occurred_at=$5::timestamptz " +
      "AND observed_at=$6::timestamptz AND evidence_source_id=$7 " +
      "AND schema_version=$8 AND payload=$9::jsonb",[
      sourceSystem,sourceEventKind,event.eventKey,event.kind,event.occurredAt,
      event.observedAt,event.evidenceRef.sourceId,event.schemaVersion,
      JSON.stringify(event.payload),
    ]);
    if(previous.rows.length!==1)
      throw new TypeError("Timeline event identity collision");
    const identities=await tx.query("SELECT kind,canonical_id FROM timeline_event_entities " +
      "WHERE source_system=$1 AND source_event_kind=$2 AND event_key=$3 " +
      "ORDER BY kind,canonical_id",[sourceSystem,sourceEventKind,event.eventKey]);
    const incoming=new Set(source.entityRefs.map(ref=>ref.kind+"|"+ref.canonicalId));
    const stored=new Set(identities.rows.map(row=>String(row.kind)+"|"+String(row.canonical_id)));
    if(incoming.size!==source.entityRefs.length||stored.size!==identities.rows.length||
       incoming.size!==stored.size||[...incoming].some(identity=>!stored.has(identity)))
      throw new TypeError("Timeline entity attribution collision");
    return false;
  }
  for (const entity of source.entityRefs) {
    await tx.query(`INSERT INTO timeline_event_entities
      (source_system,source_event_kind,event_key,kind,canonical_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
      sourceSystem,sourceEventKind,event.eventKey,entity.kind,entity.canonicalId,
    ]);
  }
  return true;
}

/**
 * "What was already KNOWN by T?" filters BOTH occurredAt and observedAt.
 * This avoids post-hoc leakage from late collected/backfilled tweets or trades.
 */
export async function queryTokenTimeline(
  tx: PgTransaction, tokenId: TokenId, occurredBefore: Date | string,
  knownAt: Date | string, limit = 100,
): Promise<Record<string, unknown>[]> {
  if (parseTokenId(tokenId)?.id !== tokenId) throw new TypeError("Noncanonical token ID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit 1..500 required");
  const result = await tx.query(`SELECT t.source_system,t.source_event_kind,t.event_key,
    t.timeline_kind,t.occurred_at,t.observed_at,t.evidence_source_id,t.payload
    FROM timeline_events t JOIN timeline_event_entities e
      ON e.source_system=t.source_system
      AND e.source_event_kind=t.source_event_kind AND e.event_key=t.event_key
    WHERE e.kind='token' AND e.canonical_id=$1
      AND t.occurred_at <= $2 AND t.observed_at <= $3
    ORDER BY t.occurred_at DESC,t.source_system,t.event_key
    LIMIT $4`, [
      tokenId,toUtcIso(occurredBefore),toUtcIso(knownAt),limit,
    ]);
  return result.rows;
}
