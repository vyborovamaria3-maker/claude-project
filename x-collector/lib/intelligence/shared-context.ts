export interface SharedIntelligenceContext {
  entityId: string;
  facts: unknown[];
  relations: unknown[];
  signals: unknown[];
  updatedAt: Date;
}

export class SharedContextStore {
  private contexts = new Map<string, SharedIntelligenceContext>();

  set(context: SharedIntelligenceContext) {
    this.contexts.set(context.entityId, context);
    return context;
  }

  get(entityId: string) {
    return this.contexts.get(entityId);
  }
}
