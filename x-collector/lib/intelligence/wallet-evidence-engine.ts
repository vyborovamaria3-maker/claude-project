export type WalletEvidence = {
  wallet: string;
  source: string;
  confidence: number;
  metadata?: Record<string, unknown>;
};

export class WalletEvidenceEngine {
  validate(evidence: WalletEvidence) {
    return {
      valid: Boolean(evidence.wallet && evidence.source),
      confidence: evidence.confidence,
    };
  }
}
