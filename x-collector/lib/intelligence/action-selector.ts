export type Action = {
  name: string;
  cost: number;
  expectedValue: number;
};

export function selectAction(actions: Action[]) {
  return [...actions].sort((a, b) => (b.expectedValue - b.cost) - (a.expectedValue - a.cost))[0] ?? null;
}
