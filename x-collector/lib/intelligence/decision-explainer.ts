export interface DecisionExplanation {
  decision: string;
  reasons: string[];
  traceId?: string;
}

export function explainDecision(decision: string, reasons: string[], traceId?: string): DecisionExplanation {
  return {
    decision,
    reasons,
    traceId,
  };
}
