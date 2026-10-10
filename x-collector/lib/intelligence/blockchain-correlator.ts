export interface BlockchainEntityLink {
  entityId: string;
  walletAddress: string;
  confidence: number;
  signals: string[];
}

export interface BlockchainCorrelationInput {
  entityId: string;
  transactions: Array<{ hash: string; value: number; timestamp: number }>;
}

export function correlateBlockchainEntity(input: BlockchainCorrelationInput): BlockchainEntityLink {
  return {
    entityId: input.entityId,
    walletAddress: '',
    confidence: Math.min(input.transactions.length / 100, 1),
    signals: input.transactions.map((tx) => tx.hash),
  };
}
