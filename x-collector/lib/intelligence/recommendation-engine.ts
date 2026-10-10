export interface IntelligenceRecommendation {
  entityId: string;
  action: string;
  priority: number;
}

export function recommendAction(input: {
  entityId: string;
  risk: number;
  influence: number;
}): IntelligenceRecommendation {
  if (input.risk > 0.8) {
    return {
      entityId: input.entityId,
      action: 'investigate_risk_signals',
      priority: 1,
    };
  }

  if (input.influence > 0.8) {
    return {
      entityId: input.entityId,
      action: 'analyze_influence_network',
      priority: 2,
    };
  }

  return {
    entityId: input.entityId,
    action: 'collect_more_evidence',
    priority: 3,
  };
}
