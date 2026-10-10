export interface KnowledgeItem {
  id: string;
  facts: string[];
  confidence?: number;
}

export interface KnowledgeSummary {
  id: string;
  summary: string;
  confidence: number;
}

export function summarizeKnowledge(items: KnowledgeItem[]): KnowledgeSummary[] {
  return items.map((item) => ({
    id: item.id,
    summary: item.facts.join('; ').slice(0, 500),
    confidence: item.confidence ?? 0.5,
  }));
}
