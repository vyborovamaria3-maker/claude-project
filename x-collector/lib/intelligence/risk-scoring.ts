export type RiskSignal = {
  type: string;
  severity: number;
  confidence: number;
};

export function calculateRiskScore(signals: RiskSignal[]) {
  if (!signals.length) return 0;

  const score = signals.reduce((sum, signal) => {
    return sum + signal.severity * signal.confidence;
  }, 0) / signals.length;

  return Math.min(1, score);
}
