export type UnifiedQueryResult = {
  entities: unknown[];
  relations: unknown[];
  evidence: unknown[];
};

export async function runUnifiedQuery(query: string): Promise<UnifiedQueryResult> {
  return {
    entities: [],
    relations: [],
    evidence: [],
  };
}
