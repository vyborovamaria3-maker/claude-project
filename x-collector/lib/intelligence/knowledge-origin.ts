export interface KnowledgeOrigin {
  knowledgeId: string;
  sources: string[];
  evidenceIds: string[];
  derivedFrom?: string[];
}

export function createKnowledgeOrigin(input: KnowledgeOrigin): KnowledgeOrigin {
  return {
    ...input,
    sources: [...input.sources],
    evidenceIds: [...input.evidenceIds],
    derivedFrom: input.derivedFrom ? [...input.derivedFrom] : []
  };
}

export function mergeKnowledgeOrigins(items: KnowledgeOrigin[]): KnowledgeOrigin {
  return {
    knowledgeId: 'merged',
    sources: [...new Set(items.flatMap((item) => item.sources))],
    evidenceIds: [...new Set(items.flatMap((item) => item.evidenceIds))],
    derivedFrom: [...new Set(items.flatMap((item) => item.derivedFrom ?? []))]
  };
}
