export interface KnowledgeMemory {
  entityId: string;
  facts: Record<string, unknown>;
  confidence: number;
  updatedAt: Date;
}

export class KnowledgeBase {
  private memories = new Map<string, KnowledgeMemory>();

  upsert(memory: KnowledgeMemory) {
    this.memories.set(memory.entityId, memory);
    return memory;
  }

  get(entityId: string) {
    return this.memories.get(entityId) ?? null;
  }
}
