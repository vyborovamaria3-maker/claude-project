export type BlockchainSignal = {
  wallet: string;
  source?: string;
  confidence: number;
  metadata?: Record<string, unknown>;
};

export class BlockchainAnalyzer {
  analyzeWalletSignals(signals: BlockchainSignal[]) {
    return signals.map((signal) => ({
      wallet: signal.wallet,
      confidence: signal.confidence,
      riskFactors: [],
      metadata: signal.metadata ?? {},
    }));
  }
}
