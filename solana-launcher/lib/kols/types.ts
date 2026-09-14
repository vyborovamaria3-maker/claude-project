export type KolChain = "solana" | "ethereum";

export type KolEvidenceKind =
  | "signed_proof"
  | "connected_profile"
  | "curated_label";

export interface KolEvidence {
  source: string;
  kind: KolEvidenceKind;
  confidence: number;
  verified: boolean;
  detail: string;
  url?: string;
}

export interface KolWalletMetrics {
  pnl1dSol?: number;
  pnl7dSol?: number;
  pnl30dSol?: number;
  wins?: number;
  losses?: number;
  winRate?: number;
}

export interface KolWallet {
  address: string;
  chain: KolChain;
  confidence: number;
  verified: boolean;
  evidence: KolEvidence[];
  metrics: KolWalletMetrics;
}

export interface KolProfile {
  handle: string;
  name: string;
  avatar: string | null;
  twitterUrl: string;
  telegramUrl: string | null;
  confidence: number;
  verified: boolean;
  wallets: KolWallet[];
  sources: string[];
}

export interface KolSourceStatus {
  source: string;
  ok: boolean;
  detail?: string;
}

export interface KolListResponse {
  items: KolProfile[];
  total: number;
  timeframe: 1 | 7 | 30;
  generatedAt: string;
  sourceStatus: KolSourceStatus[];
}
