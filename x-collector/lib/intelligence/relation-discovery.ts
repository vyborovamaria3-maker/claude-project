export type RelationCandidate = {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  confidence: number;
  evidence: Record<string, unknown>;
};

export class RelationDiscoveryService {
  suggestFromSharedSignals(input: {
    sharedTags?: string[];
    sharedClusters?: string[];
    sharedWallets?: string[];
  }): RelationCandidate[] {
    const score = Math.min(
      1,
      ((input.sharedTags?.length ?? 0) * 0.1) +
        ((input.sharedClusters?.length ?? 0) * 0.2) +
        ((input.sharedWallets?.length ?? 0) * 0.35)
    );

    if (score === 0) return [];

    return [
      {
        sourceEntityId: '',
        targetEntityId: '',
        relationType: 'CONNECTED_BY_PATTERN',
        confidence: score,
        evidence: {
          sharedTags: input.sharedTags ?? [],
          sharedClusters: input.sharedClusters ?? [],
          sharedWallets: input.sharedWallets ?? []
        }
      }
    ];
  }
}
