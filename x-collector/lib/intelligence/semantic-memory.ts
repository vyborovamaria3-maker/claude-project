export type KnowledgeFact = {
  key: string;
  value: unknown;
  confidence: number;
};

export class SemanticMemory {
  private facts = new Map<string, KnowledgeFact[]>();

  store(entityId: string, fact: KnowledgeFact) {
    const current = this.facts.get(entityId) ?? [];
    current.push(fact);
    this.facts.set(entityId, current);
    return fact;
  }

  get(entityId: string) {
    return this.facts.get(entityId) ?? [];
  }
}
