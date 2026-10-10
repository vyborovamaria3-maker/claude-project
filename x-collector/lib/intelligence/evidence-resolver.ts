import type { PoolClient } from "pg";

type Client = Pick<PoolClient, "query">;

export type EvidenceSource = {
  rawEventId: string;
  source?: string;
  confidence?: number;
  observedAt?: Date | string;
};

export type ResolvedEvidenceSource = {
  rawEventId: string;
  source: string;
  confidence: number;
  observedAt: Date;
};

export type EvidenceResolution = {
  claim: string;
  verified: boolean;
  confidence: number;
  observedAt: Date | null;
  sources: ResolvedEvidenceSource[];
  reasons: string[];
};

export const MIN_VERIFIED_CONFIDENCE = 0.5;

function toDate(value: Date | string | undefined): Date | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveEvidenceSources(claim: string, sources: EvidenceSource[]): EvidenceResolution {
  const reasons: string[] = [];
  const resolved: ResolvedEvidenceSource[] = [];
  if (!claim.trim()) reasons.push("missing_claim");
  if (!sources.length) reasons.push("missing_source");

  for (const [index, source] of sources.entries()) {
    const label = `source_${index}`;
    if (!source.rawEventId?.trim()) {
      reasons.push(`${label}_missing_raw_event`);
      continue;
    }
    if (!source.source?.trim()) {
      reasons.push(`${label}_missing_origin`);
      continue;
    }
    const observedAt = toDate(source.observedAt);
    if (!observedAt) {
      reasons.push(`${label}_missing_timestamp`);
      continue;
    }
    const confidence = source.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) {
      reasons.push(`${label}_invalid_confidence`);
      continue;
    }
    resolved.push({ rawEventId: source.rawEventId, source: source.source, confidence, observedAt });
  }

  const confidence = resolved.length
    ? Math.min(...resolved.map((item) => item.confidence))
    : 0;
  const observedAt = resolved.length
    ? new Date(Math.min(...resolved.map((item) => item.observedAt.getTime())))
    : null;
  return {
    claim,
    verified: reasons.length === 0 && confidence >= MIN_VERIFIED_CONFIDENCE,
    confidence,
    observedAt,
    sources: resolved,
    reasons,
  };
}

export async function resolveEvidenceChain(
  c: Client,
  claim: string,
  rawEventIds: string[],
): Promise<EvidenceResolution> {
  const ids = [...new Set(rawEventIds.filter((id) => id.trim()))];
  const rows = ids.length
    ? (
        await c.query<{ id: string; source: string; collected_at: Date }>(
          `SELECT id, source, collected_at FROM ip_raw_events WHERE id = ANY($1::uuid[])`,
          [ids],
        )
      ).rows
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const reasons: string[] = ids.filter((id) => !byId.has(id)).map((id) => `unknown_raw_event:${id}`);
  const sources: EvidenceSource[] = ids.map((id) => {
    const row = byId.get(id);
    return { rawEventId: id, source: row?.source ?? "", confidence: 1, observedAt: row?.collected_at ?? undefined };
  });
  const resolution = resolveEvidenceSources(claim, sources);
  return { ...resolution, reasons: [...reasons, ...resolution.reasons] };
}
