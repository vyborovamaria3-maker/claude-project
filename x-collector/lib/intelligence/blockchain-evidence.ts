export interface BlockchainEvidence {
  entityId: string;
  source: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export function createBlockchainEvidence(input: BlockchainEvidence): BlockchainEvidence {
  return input;
}
