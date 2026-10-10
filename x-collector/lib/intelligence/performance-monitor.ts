export type PerformanceMetric = {
  operation: string;
  durationMs: number;
  success: boolean;
};

export class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];

  record(metric: PerformanceMetric) {
    this.metrics.push(metric);
  }

  summary() {
    const total = this.metrics.length;
    const successful = this.metrics.filter((m) => m.success).length;

    return {
      total,
      successRate: total ? successful / total : 0,
      averageDurationMs: total
        ? this.metrics.reduce((sum, m) => sum + m.durationMs, 0) / total
        : 0,
    };
  }
}
