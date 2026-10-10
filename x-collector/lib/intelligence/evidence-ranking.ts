export type EvidenceItem = {
  id: string;
  sourceTrust: number;
  relevance: number;
  confidence: number;
};

export function rankEvidence(items: EvidenceItem[]) {
  return [...items]
    .map((item) => ({
      ...item,
      score: item.sourceTrust * 0.4 + item.relevance * 0.3 + item.confidence * 0.3,
    }))
    .sort((a, b) => b.score - a.score);
}
