export type PatternType =
  | 'SHARED_WALLET'
  | 'SHARED_CLUSTER'
  | 'BEHAVIOR_SIMILARITY'
  | 'CONTENT_SIMILARITY';

export interface PatternSignal {
  type: PatternType;
  weight: number;
  evidence: Record<string, unknown>;
}

export interface PatternResult {
  confidence: number;
  signals: PatternSignal[];
}

export class PatternDetector {
  detect(input: {
    sharedWallets?: string[];
    sharedClusters?: string[];
    behaviorScore?: number;
    contentScore?: number;
  }): PatternResult {
    const signals: PatternSignal[] = [];

    if (input.sharedWallets?.length) {
      signals.push({
        type: 'SHARED_WALLET',
        weight: 0.4,
        evidence: { wallets: input.sharedWallets }
      });
    }

    if (input.sharedClusters?.length) {
      signals.push({
        type: 'SHARED_CLUSTER',
        weight: 0.25,
        evidence: { clusters: input.sharedClusters }
      });
    }

    if ((input.behaviorScore ?? 0) > 0) {
      signals.push({
        type: 'BEHAVIOR_SIMILARITY',
        weight: input.behaviorScore ?? 0,
        evidence: { score: input.behaviorScore }
      });
    }

    if ((input.contentScore ?? 0) > 0) {
      signals.push({
        type: 'CONTENT_SIMILARITY',
        weight: input.contentScore ?? 0,
        evidence: { score: input.contentScore }
      });
    }

    const confidence = Math.min(
      1,
      signals.reduce((sum, signal) => sum + signal.weight, 0)
    );

    return { confidence, signals };
  }
}
