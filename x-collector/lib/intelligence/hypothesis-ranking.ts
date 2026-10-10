import type { Hypothesis } from './hypothesis-engine';

export class HypothesisRanking {
  rank(items: Hypothesis[]) {
    return [...items].sort((a, b) => b.confidence - a.confidence);
  }
}
