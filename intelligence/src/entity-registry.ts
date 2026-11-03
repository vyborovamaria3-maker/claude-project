import { createHash } from "node:crypto";
import {
  buildEntityRef, isSolanaSignature, toUtcIso, type EntityRef, type EvidenceRef,
} from "@claude-project/contracts";

export type RegistryEvent = {
  sourceSystem: "x" | "tg" | "blockchain" | "twitter_research";
  eventKind: string;
  eventKey: string;
  schemaVersion: string;
  entityRefs: EntityRef[];
  evidenceRef: EvidenceRef;
};

export type PgTransaction = {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

function limited(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError("Invalid " + name);
  }
  return value;
}

function validateEvidence(evidence: EvidenceRef): EvidenceRef {
  if (!evidence || !["x_tweet", "tg_message", "chain_tx"].includes(evidence.sourceKind)) {
    throw new TypeError("Unknown evidence type");
  }
  const id = limited(evidence.sourceId, "evidence source ID");
  const patterns: Record<EvidenceRef["sourceKind"], RegExp> = {
    x_tweet: /^x:tweet:[1-9][0-9]*$/,
    tg_message: /^tg:message:(?:[1-9][0-9]*|-[1-9][0-9]*):[1-9][0-9]*$/,
    chain_tx: /^chain:tx:solana:[A-Za-z0-9]+$/,
  };
  if (!patterns[evidence.sourceKind].test(id)) {
    throw new TypeError("Evidence/source identity mismatch");
  }
  if (evidence.sourceKind === "chain_tx") {
    const match = /^chain:tx:solana:(.+)$/.exec(id);
    if (!match || !isSolanaSignature(match[1])) {
      throw new TypeError("Invalid chain transaction evidence");
    }
  }
  const provider = evidence.provider === undefined ? undefined : limited(evidence.provider, "provider", 4096);
  const parserVersion = evidence.parserVersion === undefined ? undefined : limited(evidence.parserVersion, "parserVersion", 4096);
  const rawPointer = evidence.rawPointer === undefined ? undefined : limited(evidence.rawPointer, "rawPointer", 4096);
  return {
    ...evidence,
    ...(provider === undefined ? {} : {provider}),
    ...(parserVersion === undefined ? {} : {parserVersion}),
    ...(rawPointer === undefined ? {} : {rawPointer}),
    observedAt: toUtcIso(evidence.observedAt),
    ...(evidence.occurredAt === undefined ? {} : {occurredAt: toUtcIso(evidence.occurredAt)}),
  };
}

export function validateRegistryEvent(input: RegistryEvent): RegistryEvent {
  const kindForSource: Record<RegistryEvent["sourceSystem"], EvidenceRef["sourceKind"]> = {
    x: "x_tweet", tg: "tg_message", blockchain: "chain_tx", twitter_research: "x_tweet",
  };
  if (!Object.hasOwn(kindForSource, input.sourceSystem)) {
    throw new TypeError("Unsupported sourceSystem");
  }
  limited(input.eventKind, "eventKind");
  limited(input.eventKey, "eventKey");
  limited(input.schemaVersion, "schemaVersion");
  if (!Array.isArray(input.entityRefs) || input.entityRefs.length < 1 || input.entityRefs.length > 200) {
    throw new TypeError("Expected 1..200 entityRefs");
  }
  const evidenceRef = validateEvidence(input.evidenceRef);
  if (kindForSource[input.sourceSystem] !== evidenceRef.sourceKind) {
    throw new TypeError("Evidence does not belong to sourceSystem");
  }
  const entityRefs = input.entityRefs.map(ref => buildEntityRef({
    kind: ref.kind, canonicalId: ref.canonicalId,
    firstSeenAt: ref.firstSeenAt, lastSeenAt: ref.lastSeenAt,
  }));
  return {...input, entityRefs, evidenceRef};
}

/** Hash the complete normalized event; entity reference order is non-semantic. */
function fingerprintValidatedRegistryEvent(event: RegistryEvent): string {
  const entityRefs = event.entityRefs.map(ref => ({
    kind: ref.kind, canonicalId: ref.canonicalId,
    firstSeenAt: ref.firstSeenAt, lastSeenAt: ref.lastSeenAt,
  })).sort((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const evidence = event.evidenceRef;
  const canonical = {
    sourceSystem: event.sourceSystem, eventKind: event.eventKind,
    eventKey: event.eventKey, schemaVersion: event.schemaVersion, entityRefs,
    evidenceRef: {
      sourceKind: evidence.sourceKind, sourceId: evidence.sourceId,
      observedAt: evidence.observedAt, occurredAt: evidence.occurredAt ?? null,
      provider: evidence.provider ?? null, parserVersion: evidence.parserVersion ?? null,
      rawPointer: evidence.rawPointer ?? null,
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** Public helper used by the bounded legacy-inbox fingerprint backfill. */
export function registryEventFingerprint(input: RegistryEvent): string {
  return fingerprintValidatedRegistryEvent(validateRegistryEvent(input));
}
/**
 * Caller MUST open a destination PostgreSQL transaction before calling and
 * commit it before ACK-ing the SOURCE outbox event. No implicit transactions.
 */
export async function ingestRegistryEvent(tx: PgTransaction, incoming: RegistryEvent): Promise<boolean> {
  const event = validateRegistryEvent(incoming);
  const payloadSha256 = fingerprintValidatedRegistryEvent(event);
  const result = await tx.query(`INSERT INTO intelligence_inbox
    (source_system, event_kind, event_key, schema_version, evidence_source_id, payload_sha256)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_system, event_kind, event_key) DO NOTHING
    RETURNING event_key`, [
    event.sourceSystem, event.eventKind, event.eventKey,
    event.schemaVersion, event.evidenceRef.sourceId, payloadSha256,
  ]);
  if (result.rows.length === 0) {
    const previous = await tx.query(`SELECT schema_version,evidence_source_id,payload_sha256 FROM intelligence_inbox
      WHERE source_system=$1 AND event_kind=$2 AND event_key=$3`,[
      event.sourceSystem,event.eventKind,event.eventKey,
    ]);
    if (previous.rows.length !== 1 ||
        previous.rows[0]?.schema_version !== event.schemaVersion ||
        previous.rows[0]?.evidence_source_id !== event.evidenceRef.sourceId ||
        previous.rows[0]?.payload_sha256 !== payloadSha256) {
      // Legacy rows without a fingerprint are deliberately not accepted as safe duplicates.
      throw new TypeError("Outbox event identity collision or legacy fingerprint missing");
    }
    return false;
  }

  for (const entity of event.entityRefs) {
    await tx.query(`INSERT INTO entity_registry
      (kind,canonical_id,first_seen_at,last_seen_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (kind,canonical_id) DO UPDATE SET
        first_seen_at=LEAST(entity_registry.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at=GREATEST(entity_registry.last_seen_at, EXCLUDED.last_seen_at),
        updated_at=NOW()`, [
      entity.kind, entity.canonicalId, entity.firstSeenAt, entity.lastSeenAt,
    ]);
    await tx.query(`INSERT INTO entity_evidence
      (source_system,event_kind,event_key,kind,canonical_id,evidence_source_id,
       evidence_kind,observed_at,occurred_at,parser_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING`, [
      event.sourceSystem, event.eventKind, event.eventKey,
      entity.kind, entity.canonicalId, event.evidenceRef.sourceId,
      event.evidenceRef.sourceKind, event.evidenceRef.observedAt,
      event.evidenceRef.occurredAt ?? null, event.evidenceRef.parserVersion ?? null,
    ]);
  }
  return true;
}
