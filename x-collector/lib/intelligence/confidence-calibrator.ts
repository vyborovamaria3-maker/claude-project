export function calibrateConfidence(input: {
  confidence: number;
  evidenceCount?: number;
  sourceReliability?: number;
}): number {
  const evidenceFactor = Math.min(1, (input.evidenceCount ?? 0) / 5);
  const sourceFactor = input.sourceReliability ?? 0.5;

  const score =
    input.confidence * 0.5 +
    evidenceFactor * 0.3 +
    sourceFactor * 0.2;

  return Math.min(1, Math.max(0, score));
}
