export type SimilarityResult = {
  entityId: string;
  similarity: number;
  reasons: string[];
};

export class SimilarityEngine {
  compareSignals(a: Record<string, unknown>, b: Record<string, unknown>): SimilarityResult {
    const reasons: string[] = [];
    let score = 0;

    if (a['topic'] && a['topic'] === b['topic']) {
      score += 0.3;
      reasons.push('shared_topic');
    }

    if (a['cluster'] && a['cluster'] === b['cluster']) {
      score += 0.4;
      reasons.push('shared_cluster');
    }

    if (a['wallet'] && a['wallet'] === b['wallet']) {
      score += 0.3;
      reasons.push('shared_wallet');
    }

    return {
      entityId: String(b['entityId'] ?? ''),
      similarity: Math.min(score, 1),
      reasons
    };
  }
}
