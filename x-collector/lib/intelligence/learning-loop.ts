export type LearningSignal = {
  entityId: string;
  source: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export class IntelligenceLearningLoop {
  private signals: LearningSignal[] = [];

  record(signal: LearningSignal) {
    this.signals.push(signal);
    return signal;
  }

  getSignals(entityId: string) {
    return this.signals.filter((s) => s.entityId === entityId);
  }
}
