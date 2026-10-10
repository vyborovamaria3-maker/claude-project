export type IntelligenceProfile = {
  entityId: string;
  scores: Record<string, number>;
  tags: Array<{ name: string; confidence: number }>;
  relations: number;
  anomalies: number;
};

/**
 * Aggregation layer for intelligence UI/API.
 * Keeps dashboard logic separate from collectors and storage.
 */
export class IntelligenceDashboardService {
  constructor(private readonly db: any) {}

  async getEntityProfile(entityId: string): Promise<IntelligenceProfile> {
    const [scores, tags, relations, anomalies] = await Promise.all([
      this.db.ip_entity_scores?.findFirst?.({ where: { entity_id: entityId } }),
      this.db.ip_entity_tags?.findMany?.({ where: { entity_id: entityId } }),
      this.db.ip_entity_relations?.count?.({ where: { source_entity_id: entityId } }),
      this.db.ip_graph_anomalies?.count?.({ where: { entity_id: entityId } }),
    ]);

    return {
      entityId,
      scores: scores ?? {},
      tags: tags ?? [],
      relations: relations ?? 0,
      anomalies: anomalies ?? 0,
    };
  }
}
