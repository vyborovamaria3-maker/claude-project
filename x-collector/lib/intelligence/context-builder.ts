export type IntelligenceContext = {
  entityId: string;
  facts: unknown[];
  history: unknown[];
};

export class ContextBuilder {
  build(entityId: string, facts: unknown[] = [], history: unknown[] = {} as unknown[]) {
    return {
      entityId,
      facts,
      history: Array.isArray(history) ? history : []
    };
  }
}
