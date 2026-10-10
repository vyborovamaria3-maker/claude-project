export type WalletNetwork = {
  wallet: string;
  connections: string[];
  density: number;
};

export function analyzeWalletNetwork(input: {
  wallet: string;
  counterparties: string[];
}): WalletNetwork {
  const unique = [...new Set(input.counterparties)];

  return {
    wallet: input.wallet,
    connections: unique,
    density: Number(Math.min(unique.length / 100, 1).toFixed(2))
  };
}
