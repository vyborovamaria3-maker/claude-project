export type FactClaim = {
  claim: string;
  evidenceCount: number;
  confidence: number;
};

export function verifyFact(claim: FactClaim) {
  const verificationScore = Math.min(1, claim.confidence * 0.7 + Math.min(claim.evidenceCount, 10) / 10 * 0.3);

  return {
    claim: claim.claim,
    verified: verificationScore >= 0.7,
    score: verificationScore,
  };
}
