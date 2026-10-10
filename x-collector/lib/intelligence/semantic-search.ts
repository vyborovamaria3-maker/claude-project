export type SemanticDocument = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export function semanticSearch(documents: SemanticDocument[], query: string): SemanticDocument[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  return documents.filter((document) => {
    const text = document.text.toLowerCase();
    return terms.some((term) => text.includes(term));
  });
}
