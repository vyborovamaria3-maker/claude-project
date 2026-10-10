import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type Client = Pick<PoolClient, "query">;

export const ENTITY_TYPES = [
  "PERSON",
  "ACCOUNT",
  "WALLET",
  "TOKEN",
  "PROJECT",
  "COMPANY",
  "ORGANIZATION",
  "CONTRACT",
  "TOPIC",
  "LOCATION",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type EntityObservation = {
  type: EntityType;
  platform: string;
  externalId: string;
  name: string;
  rawEventId: string;
  observedAt: Date;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

export type ResolvedEntity = {
  id: string;
  type: EntityType;
  platform: string;
  externalId: string;
  name: string;
  observations: number;
  confidence: number;
  metadata: Record<string, unknown>;
};

export class ObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationError";
  }
}

export function observationKey(observation: Pick<EntityObservation, "type" | "platform" | "externalId">): string {
  return `${observation.type}|${observation.platform}|${observation.externalId}`;
}

function confidenceOf(observation: EntityObservation): number {
  const value = observation.confidence ?? 1;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ObservationError(`Confidence must be within (0, 1] for ${observationKey(observation)}`);
  }
  return value;
}

function assertObservation(observation: EntityObservation): void {
  if (!ENTITY_TYPES.includes(observation.type)) {
    throw new ObservationError(`Unsupported entity type ${JSON.stringify(observation.type)}`);
  }
  if (!observation.platform.trim()) throw new ObservationError("Observation platform is required");
  if (!observation.externalId.trim()) throw new ObservationError("Observation externalId is required");
  if (!observation.name.trim()) throw new ObservationError("Observation name is required");
  if (!observation.rawEventId.trim()) {
    throw new ObservationError(`Observation for ${observationKey(observation)} requires a raw event`);
  }
  if (!(observation.observedAt instanceof Date) || Number.isNaN(observation.observedAt.getTime())) {
    throw new ObservationError(`Observation for ${observationKey(observation)} requires a valid observedAt`);
  }
  confidenceOf(observation);
}

export async function resolveEntities(c: Client, observations: EntityObservation[]): Promise<ResolvedEntity[]> {
  if (!observations.length) throw new ObservationError("At least one observation is required");
  for (const observation of observations) assertObservation(observation);

  const evidenceIds = [...new Set(observations.map((observation) => observation.rawEventId))];
  const found = await c.query<{ id: string }>(
    `SELECT id FROM ip_raw_events WHERE id = ANY($1::uuid[])`,
    [evidenceIds],
  );
  if (found.rows.length !== evidenceIds.length) {
    throw new ObservationError("Every observation must reference an existing raw event");
  }

  const groups = new Map<string, EntityObservation[]>();
  for (const observation of observations) {
    const key = observationKey(observation);
    const group = groups.get(key);
    if (group) group.push(observation);
    else groups.set(key, [observation]);
  }

  const resolved: ResolvedEntity[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = [...groups.get(key)!].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    const latest = group[group.length - 1];
    const metadata = group.reduce<Record<string, unknown>>((acc, item) => ({ ...acc, ...(item.metadata ?? {}) }), {});
    const row = await c.query<{ id: string }>(
      `INSERT INTO ip_entities(id, type, platform, external_id, name, metadata)
       VALUES($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT(type, platform, external_id)
       DO UPDATE SET name = EXCLUDED.name, metadata = ip_entities.metadata || EXCLUDED.metadata, updated_at = now()
       RETURNING id`,
      [randomUUID(), latest.type, latest.platform, latest.externalId, latest.name, JSON.stringify(metadata)],
    );
    resolved.push({
      id: row.rows[0].id,
      type: latest.type,
      platform: latest.platform,
      externalId: latest.externalId,
      name: latest.name,
      observations: group.length,
      confidence: Math.max(...group.map(confidenceOf)),
      metadata,
    });
  }
  return resolved;
}
