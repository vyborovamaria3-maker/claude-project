export interface PredictionInput {
  entityId: string;
  signals: Array<{ name: string; value: number }>;
}

export interface PredictionResult {
  entityId: string;
  score: number;
  factors: string[];
}

export function predict(input: PredictionInput): PredictionResult {
  const score = input.signals.reduce((sum, signal) => sum + signal.value, 0) / Math.max(input.signals.length, 1);

  return {
    entityId: input.entityId,
    score,
    factors: input.signals.map((signal) => signal.name),
  };
}
