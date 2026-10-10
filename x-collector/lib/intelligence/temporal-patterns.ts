export type TemporalSignal = {
  entityId: string;
  values: number[];
};

export function detectTemporalPattern(signal: TemporalSignal) {
  const values = signal.values;
  if (values.length < 2) return { trend: "unknown", score: 0 };

  const change = values[values.length - 1] - values[0];
  return {
    trend: change > 0 ? "increasing" : change < 0 ? "decreasing" : "stable",
    score: Math.min(1, Math.abs(change) / 100)
  };
}
