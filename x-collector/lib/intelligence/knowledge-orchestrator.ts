export interface KnowledgeContext {
  entityId?: string;
  facts: unknown[];
  relations: unknown[];
  evidence: unknown[];
  metadata: Record<string, unknown>;
}

export class KnowledgeOrchestrator {
  buildContext(input: Partial<KnowledgeContext>): KnowledgeContext {
    return {
      facts: input.facts ?? [],
      relations: input.relations ?? [],
      evidence: input.evidence ?? [],
      entityId: input.entityId,
      metadata: input.metadata ?? {},
    };
  }
}
