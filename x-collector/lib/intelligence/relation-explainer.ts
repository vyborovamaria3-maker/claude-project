export type RelationExplanation = {
  source: string;
  target: string;
  relationType: string;
  evidence: unknown[];
};

export class RelationExplainer {
  explain(relation: RelationExplanation) {
    return {
      relation: `${relation.source} -> ${relation.target}`,
      type: relation.relationType,
      reason: `Detected relation supported by ${relation.evidence.length} evidence items.`,
      confidence: Math.min(1, relation.evidence.length / 10),
    };
  }
}
