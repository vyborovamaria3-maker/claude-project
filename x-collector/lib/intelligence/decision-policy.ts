export type DecisionPolicy = {
  minimumConfidence: number;
  minimumEvidence: number;
};

export function evaluatePolicy(input: { confidence: number; evidenceCount: number }, policy: DecisionPolicy) {
  return input.confidence >= policy.minimumConfidence && input.evidenceCount >= policy.minimumEvidence;
}
