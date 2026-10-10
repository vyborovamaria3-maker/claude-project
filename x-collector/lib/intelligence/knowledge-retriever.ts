export class KnowledgeRetriever {
  constructor(private readonly source: { recall?: (key: string) => unknown }) {}

  retrieve(keys: string[]) {
    return keys.map((key) => ({ key, value: this.source.recall?.(key) ?? null }));
  }
}
