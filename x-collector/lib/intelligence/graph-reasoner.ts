export type GraphReasoningContext = {
  entityId: string;
  relations: unknown[];
  evidence: unknown[];
  scores: Record<string, number>;
};

export class GraphReasoner {
  explainConnection(context: GraphReasoningContext) {
    return {
      entityId: context.entityId,
      explanation: 'Connection explanation generated from graph relations, evidence and scores.',
      confidence: this.calculateConfidence(context),
    };
  }

  private calculateConfidence(context: GraphReasoningContext) {
    const signals = context.relations.length + context.evidence.length;
    return Math.min(1, Number((signals / 100).toFixed(2)));
  }
}
