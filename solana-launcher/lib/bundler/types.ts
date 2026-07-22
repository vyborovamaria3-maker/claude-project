// data-tag: lib.bundler.types
// Bundler types adapted from pumpfun-bundler

import { Keypair, PublicKey } from "@solana/web3.js";

export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image?: string; // base64 or IPFS hash
  twitter?: string;
  telegram?: string;
  website?: string;
  showName?: boolean;
}

export interface BundlerWallet {
  keypair: Keypair;
  label: string;
  solBalance: number;
  tokenBalance?: number;
}

export interface BundleConfig {
  // LP wallet (token creator)
  lpWallet: Keypair;
  // Bundler wallets for coordinated buys
  bundlerWallets: BundlerWallet[];
  // Token metadata
  token: TokenMetadata;
  // Buy amounts (SOL per wallet)
  buyAmounts: number[];
  // Priority fee in SOL
  priorityFee: number;
  // Jito tip in SOL
  jitoFee: number;
  // Bundle wallet count
  batchSize: number;
}

export interface BundleResult {
  success: boolean;
  signature?: string;
  bundleId?: string;
  error?: string;
  mint?: string;
  lutAddress?: string;
}

export interface WalletSet {
  id: string;
  name: string;
  wallets: BundlerWallet[];
  createdAt: number;
}

export interface TokenLaunchConfig {
  token: TokenMetadata;
  lpWallet: Keypair;
  bundlerProvider: Keypair;
  bundlerWallets: Keypair[];
  buyAmountsSol: number[];
  priorityFee: number;
  jitoFee: number;
}

export type BundleStatus = "pending" | "simulating" | "sending" | "confirmed" | "failed";

export interface ActiveBundle {
  id: string;
  status: BundleStatus;
  config: BundleConfig;
  progress: number;
  results: BundleResult[];
  logs: string[];
}
