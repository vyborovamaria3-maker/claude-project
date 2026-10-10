import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { EntityType } from "./entity-resolution";

type Client = Pick<PoolClient, "query">;

export type IdentityRelation = "SAME_HANDLE" | "SAME_PERSON" | "SAME_WALLET";

export type IdentityCandidate = {
  entityA: string;
  entityB: string;
  type: string;
  externalId: string;
  platformA: string;
  platformB: string;
  evidence: string | null;
  confidence: number;
};

export type IdentityLinkInput = {
  entityA: string;
  entityB: string;
  relation: IdentityRelation;
  confidence: number;
  evidence: string;
  observedAt: Date;
};

export class MissingEvidenceError extends Error {
  constructor(readonly detail: string) {
    super(`Identity link requires evidence: ${detail}`);
    this.name = "MissingEvidenceError";
  }
}

const CANDIDATE_SQL = `
SELECT a.id AS entity_a, b.id AS entity_b, a.type, lower(a.external_id) AS external_id,
       a.platform AS platform_a, b.platform AS platform_b,
       COALESCE(
         (SELECT e.raw_event_id FROM ip_behavior_events e
          WHERE e.actor_entity IN (a.id, b.id)
          ORDER BY e.timestamp DESC NULLS LAST LIMIT 1),
         (SELECT s.raw_event_id FROM ip_entity_snapshots s
          WHERE s.entity_id IN (a.id, b.id)
          ORDER BY s.observed_at DESC LIMIT 1)
       ) AS evidence
FROM ip_entities a
JOIN ip_entities b
  ON a.id < b.id
 AND a.type = b.type
 AND a.platform <> b.platform
 AND lower(a.external_id) = lower(b.external_id)
WHERE a.type IN ('ACCOUNT', 'PERSON')
ORDER BY a.id, b.id`;

export async function findIdentityCandidates(c: Client): Promise<IdentityCandidate[]> {
  const result = await c.query<{
    entity_a: string;
    entity_b: string;
    type: EntityType;
    external_id: string;
    platform_a: string;
    platform_b: string;
    evidence: string | null;
  }>(CANDIDATE_SQL);
  return result.rows.map((row) => ({
    entityA: row.entity_a,
    entityB: row.entity_b,
    type: row.type,
    externalId: row.external_id,
    platformA: row.platform_a,
    platformB: row.platform_b,
    evidence: row.evidence,
    confidence: 0.9,
  }));
}

export async function linkIdentity(c: Client, input: IdentityLinkInput): Promise<string> {
  if (input.entityA === input.entityB) throw new MissingEvidenceError("entityA and entityB must differ");
  if (!Number.isFinite(input.confidence) || input.confidence <= 0 || input.confidence > 1) {
    throw new MissingEvidenceError("confidence must be within (0, 1]");
  }
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) {
    throw new MissingEvidenceError("observedAt must be a valid date");
  }
  if (!input.evidence) throw new MissingEvidenceError("raw event id is required");
  const raw = await c.query<{ id: string; collected_at: Date }>(
    `SELECT id, collected_at FROM ip_raw_events WHERE id = $1`,
    [input.evidence],
  );
  if (!raw.rows[0]) throw new MissingEvidenceError(`raw event ${input.evidence} does not exist`);

  const row = await c.query<{ id: string }>(
    `INSERT INTO ip_identity_links(id, entity_a, entity_b, relation, confidence, evidence, valid_from)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(entity_a, entity_b, relation, evidence)
     DO UPDATE SET confidence = GREATEST(ip_identity_links.confidence, EXCLUDED.confidence),
                   valid_from = LEAST(ip_identity_links.valid_from, EXCLUDED.valid_from),
                   valid_to = NULL
     RETURNING id`,
    [
      randomUUID(),
      input.entityA,
      input.entityB,
      input.relation,
      input.confidence,
      input.evidence,
      input.observedAt,
    ],
  );
  return row.rows[0].id;
}
