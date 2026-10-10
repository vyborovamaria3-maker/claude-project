export type KnowledgeSignal = {
  source: string;
  facts: string[];
  confidence: number;
};

export function buildKnowledgeInference(signal: KnowledgeSignal) {
  return {
    source: signal.source,
    facts: signal.facts,
    confidence: signal.confidence,
  };
}
