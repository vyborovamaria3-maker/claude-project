export type BlockchainEntityLink = {
  entityId: string;
  walletAddress: string;
  confidence: number;
  evidence: string[];
};

export class BlockchainEntityLinker {
  createLink(input: BlockchainEntityLink) {
    return {
      ...input,
      createdAt: new Date().toISOString(),
    };
  }
}
