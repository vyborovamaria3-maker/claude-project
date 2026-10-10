export type SupportedChain = "ethereum" | "solana" | "bitcoin";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = ["ethereum", "solana", "bitcoin"];

export type ChainTransaction = {
  chain: SupportedChain;
  hash: string;
  from: string;
  to: string;
  token: string | null;
  amount: string;
  timestamp: Date | null;
  rawEventId: string;
};

export type ChainWallet = {
  chain: SupportedChain;
  address: string;
  entityId: string;
  balance: string | null;
  observedAt: Date | null;
  rawEventId: string | null;
};

export interface BlockchainAdapter {
  readonly chain: SupportedChain;
  getTransaction(hash: string): Promise<ChainTransaction | null>;
  getWallet(address: string): Promise<ChainWallet | null>;
  getBalance(address: string): Promise<string | null>;
}

export class ChainValidationError extends Error {
  constructor(readonly chain: string, readonly value: string, reason: string) {
    super(`Invalid ${chain} value ${JSON.stringify(value)}: ${reason}`);
    this.name = "ChainValidationError";
  }
}

const BASE58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;
const ETHEREUM_ADDRESS = /^0x[\da-f]{40}$/i;
const ETHEREUM_HASH = /^0x[\da-f]{64}$/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BITCOIN_BECH32 = /^bc1[0-9ac-hj-np-z]{11,71}$/;
const BITCOIN_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{25,35}$/;
const BITCOIN_HASH = /^[\da-f]{64}$/i;

export function isSupportedChain(value: string): value is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

export function assertSupportedChain(value: string): SupportedChain {
  if (!isSupportedChain(value)) throw new ChainValidationError(value, value, "unsupported chain");
  return value;
}

function isBitcoinAddress(value: string): boolean {
  if (/^bc1/i.test(value)) {
    if (value !== value.toLowerCase() && value !== value.toUpperCase()) return false;
    return BITCOIN_BECH32.test(value.toLowerCase());
  }
  return BITCOIN_BASE58.test(value) && BASE58_ALPHABET.test(value);
}

export function validateAddress(chain: SupportedChain, value: string): boolean {
  if (chain === "ethereum") return ETHEREUM_ADDRESS.test(value);
  if (chain === "solana") return SOLANA_ADDRESS.test(value) && BASE58_ALPHABET.test(value);
  return isBitcoinAddress(value);
}

export function validateTransactionHash(chain: SupportedChain, value: string): boolean {
  if (chain === "ethereum") return ETHEREUM_HASH.test(value);
  if (chain === "solana") return SOLANA_SIGNATURE.test(value) && BASE58_ALPHABET.test(value);
  return BITCOIN_HASH.test(value);
}

export function normalizeAddress(chain: SupportedChain, value: string): string {
  if (!validateAddress(chain, value)) throw new ChainValidationError(chain, value, "address");
  if (chain === "ethereum") return value.toLowerCase();
  if (chain === "bitcoin" && /^bc1/i.test(value)) return value.toLowerCase();
  return value;
}

export function normalizeTransactionHash(chain: SupportedChain, value: string): string {
  if (!validateTransactionHash(chain, value)) throw new ChainValidationError(chain, value, "transaction hash");
  if (chain === "ethereum" || chain === "bitcoin") return value.toLowerCase();
  return value;
}
