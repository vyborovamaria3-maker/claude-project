export function compareHistoricalStates(previous: Record<string, number>, current: Record<string, number>) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);

  return Array.from(keys).map((key) => ({
    key,
    previous: previous[key] ?? 0,
    current: current[key] ?? 0,
    delta: (current[key] ?? 0) - (previous[key] ?? 0)
  }));
}
