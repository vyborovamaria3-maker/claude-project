export type BridgeAnalysisInput = {
  entityId: string;
  connectedClusters: number;
  relationCount: number;
};

export type BridgeScore = {
  entityId: string;
  score: number;
  reason: string[];
};

export function calculateBridgeScore(input: BridgeAnalysisInput): BridgeScore {
  const score = Math.min(1, (input.connectedClusters * 0.25) + (Math.min(input.relationCount, 100) / 100 * 0.5));

  return {
    entityId: input.entityId,
    score,
    reason: [
      'cluster_connectivity',
      'relation_density'
    ]
  };
}
