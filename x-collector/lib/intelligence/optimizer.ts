export type OptimizationSignal = {
  taskType: string;
  successRate: number;
  averageScore: number;
};

export class IntelligenceOptimizer {
  optimize(signals: OptimizationSignal[]) {
    return signals
      .map((signal) => ({
        ...signal,
        priorityAdjustment: signal.successRate * signal.averageScore,
      }))
      .sort((a, b) => b.priorityAdjustment - a.priorityAdjustment);
  }
}
