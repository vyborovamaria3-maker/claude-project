export interface ExplanationInput {
  entityId: string;
  decision: string;
  evidence: string[];
  confidence: number;
}

export interface ExplanationResult {
  summary: string;
  confidence: number;
  evidence: string[];
}

export function buildExplanation(input: ExplanationInput): ExplanationResult {
  return {
    summary: `Decision ${input.decision} for ${input.entityId} based on ${input.evidence.length} evidence items`,
    confidence: input.confidence,
    evidence: input.evidence,
  };
}
