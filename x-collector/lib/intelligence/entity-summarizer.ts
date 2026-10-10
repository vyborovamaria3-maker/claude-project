export type EntitySummaryInput = {
  id: string;
  name?: string;
  tags: string[];
  relationsCount: number;
  riskScore?: number;
  influenceScore?: number;
};

export class EntitySummarizer {
  summarize(entity: EntitySummaryInput) {
    return {
      entityId: entity.id,
      summary: `${entity.name ?? 'Entity'} has ${entity.relationsCount} known relations and ${entity.tags.length} tags.`,
      metrics: {
        risk: entity.riskScore ?? 0,
        influence: entity.influenceScore ?? 0,
      },
    };
  }
}
