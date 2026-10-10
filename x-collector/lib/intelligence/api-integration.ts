export type IntelligenceProfile = {
  entityId: string;
  scores?: {
    influence?: number;
    risk?: number;
    trust?: number;
    activity?: number;
  };
  relations?: number;
  tags?: unknown[];
  anomalies?: unknown[];
  communities?: unknown[];
  bridges?: unknown[];
};

export function buildIntelligenceProfile(input: Partial<IntelligenceProfile>): IntelligenceProfile {
  return {
    entityId: input.entityId ?? '',
    scores: input.scores ?? {},
    relations: input.relations ?? 0,
    tags: input.tags ?? [],
    anomalies: input.anomalies ?? [],
    communities: input.communities ?? [],
    bridges: input.bridges ?? [],
  };
}
