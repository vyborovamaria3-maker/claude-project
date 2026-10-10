export type Hypothesis = {
  id: string;
  description: string;
  confidence: number;
  signals: unknown[];
};

export class HypothesisEngine {
  generate(description: string, signals: unknown[]): Hypothesis {
    return {
      id: crypto.randomUUID(),
      description,
      confidence: Math.min(1, Number((signals.length / 100).toFixed(2))),
      signals,
    };
  }
}
