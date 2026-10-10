import type { Hypothesis } from './hypothesis-engine';

export class HypothesisValidation {
  validate(hypothesis: Hypothesis, evidenceCount: number) {
    return {
      hypothesisId: hypothesis.id,
      validated: evidenceCount > 0,
      confidence: Math.min(1, hypothesis.confidence + evidenceCount / 100),
    };
  }
}
