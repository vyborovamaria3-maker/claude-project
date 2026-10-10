export type TransactionPattern = {
  type: string;
  confidence: number;
  evidence: Record<string, unknown>;
};

export function detectTransactionPattern(input: {
  transferCount: number;
  uniqueCounterparties: number;
}): TransactionPattern[] {
  const patterns: TransactionPattern[] = [];

  if (input.transferCount > 100 && input.uniqueCounterparties < 10) {
    patterns.push({
      type: 'CONCENTRATED_FLOW',
      confidence: 0.75,
      evidence: input
    });
  }

  if (input.uniqueCounterparties > 50) {
    patterns.push({
      type: 'HIGH_NETWORK_ACTIVITY',
      confidence: 0.65,
      evidence: input
    });
  }

  return patterns;
}
