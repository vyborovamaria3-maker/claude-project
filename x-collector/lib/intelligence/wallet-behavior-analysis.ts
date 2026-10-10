export interface WalletBehaviorProfile {
  wallet: string;
  activityScore: number;
  patterns: string[];
}

export function analyzeWalletBehavior(wallet: string, transactions: number[]): WalletBehaviorProfile {
  return {
    wallet,
    activityScore: Math.min(transactions.length / 100, 1),
    patterns: transactions.length > 10 ? ['active_wallet'] : ['low_activity'],
  };
}
