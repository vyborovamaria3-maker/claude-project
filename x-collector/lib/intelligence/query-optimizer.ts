export type QueryPlan = {
  operation: string;
  filters: Record<string, unknown>;
  limit?: number;
};

export class IntelligenceQueryOptimizer {
  optimize(plan: QueryPlan): QueryPlan {
    return {
      ...plan,
      limit: plan.limit ?? 100,
      filters: plan.filters ?? {},
    };
  }

  shouldCache(plan: QueryPlan): boolean {
    return [
      'entity_profile',
      'graph_neighbors',
      'influence_score',
    ].includes(plan.operation);
  }
}
