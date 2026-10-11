export type GraphMetricType =
  | 'CENTRALITY'
  | 'BRIDGE_SCORE'
  | 'CLUSTER_IMPORTANCE'
  | 'INFLUENCE_PROPAGATION'
  | 'ANOMALY_SCORE';

export interface GraphMetric {
  entityId: number;
  type: GraphMetricType;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface GraphAnomaly {
  entityId: number;
  type: string;
  score: number;
  evidence?: Record<string, unknown>;
}

export class GraphAnalyticsService {
  calculateCentrality(relations: number, weightedRelations: number): number {
    if (!relations) return 0;
    return Math.min(1, (relations * 0.7 + weightedRelations * 0.3) / 100);
  }

  calculateBridgeScore(uniqueClusters: number, connections: number): number {
    if (!connections) return 0;
    return Math.min(1, uniqueClusters / connections);
  }

  detectAnomaly(entityId: number, activityChange: number): GraphAnomaly | null {
    if (activityChange < 3) return null;

    return {
      entityId,
      type: 'ACTIVITY_SPIKE',
      score: Math.min(1, activityChange / 100),
      evidence: {
        activityChange,
      },
    };
  }
}
