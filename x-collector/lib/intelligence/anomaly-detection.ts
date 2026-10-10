export type ActivitySignal = {
  value: number;
  baseline: number;
};

export function detectAnomaly(signal: ActivitySignal) {
  if (signal.baseline === 0) return 0;

  return Math.min(
    1,
    Math.abs(signal.value - signal.baseline) / signal.baseline
  );
}
