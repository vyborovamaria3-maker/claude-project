export type ReasoningStep = {
  action: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  confidence: number;
};

export class ReasoningChain {
  private steps: ReasoningStep[] = [];

  add(step: ReasoningStep) {
    this.steps.push(step);
    return step;
  }

  getSteps() {
    return [...this.steps];
  }

  confidence() {
    if (!this.steps.length) return 0;
    return this.steps.reduce((sum, step) => sum + step.confidence, 0) / this.steps.length;
  }
}
