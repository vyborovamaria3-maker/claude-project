export function calculatePriority(input: {
  risk: number;
  influence: number;
  activity: number;
}): number {
  return Number((
    input.risk * 0.4 +
    input.influence * 0.35 +
    input.activity * 0.25
  ).toFixed(3));
}

export function shouldEscalate(priority: number): boolean {
  return priority >= 0.8;
}
