export interface StrategyScore {
  strategy: string;
  successRate: number;
  usageCount: number;
}

export function optimizeStrategy(strategies: StrategyScore[]): StrategyScore | null {
  if (!strategies.length) return null;

  return [...strategies].sort((a, b) => {
    const aScore = a.successRate * Math.log(a.usageCount + 1);
    const bScore = b.successRate * Math.log(b.usageCount + 1);
    return bScore - aScore;
  })[0];
}
