export type IntelligenceMetric = {
  name: string;
  value: number;
  timestamp: string;
};

const metrics: IntelligenceMetric[] = [];

export function recordMetric(name: string, value: number) {
  metrics.push({ name, value, timestamp: new Date().toISOString() });
}

export function getMetrics() {
  return [...metrics];
}
