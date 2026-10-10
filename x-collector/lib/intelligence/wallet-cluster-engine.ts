export type WalletCluster = {
  wallets: string[];
  confidence: number;
  signals: string[];
};

export class WalletClusterEngine {
  buildClusters(wallets: string[]): WalletCluster[] {
    if (!wallets.length) return [];

    return [
      {
        wallets,
        confidence: 0,
        signals: [],
      },
    ];
  }
}
