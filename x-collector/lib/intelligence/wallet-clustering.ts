export interface WalletCluster {
  id: string;
  wallets: string[];
  score: number;
}

export function clusterWallets(wallets: string[][]): WalletCluster[] {
  return wallets.map((group, index) => ({
    id: `cluster-${index + 1}`,
    wallets: group,
    score: group.length,
  }));
}
