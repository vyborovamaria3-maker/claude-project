export interface TransactionPattern {
  type: string;
  score: number;
}

export function detectTransactionPatterns(values: number[]): TransactionPattern[] {
  const total = values.reduce((sum, value) => sum + value, 0);

  return [
    {
      type: total > 0 ? 'activity_detected' : 'no_activity',
      score: Math.min(values.length / 100, 1),
    },
  ];
}
