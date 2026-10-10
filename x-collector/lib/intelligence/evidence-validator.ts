export type EvidenceValidation = {
  valid: boolean;
  confidence: number;
  reasons: string[];
};

export function validateEvidence(evidence: {
  source?: string;
  timestamp?: string;
  payload?: unknown;
}): EvidenceValidation {
  const reasons: string[] = [];

  if (!evidence.source) reasons.push('missing_source');
  if (!evidence.timestamp) reasons.push('missing_timestamp');
  if (!evidence.payload) reasons.push('missing_payload');

  return {
    valid: reasons.length === 0,
    confidence: Math.max(0, 1 - reasons.length * 0.3),
    reasons,
  };
}
