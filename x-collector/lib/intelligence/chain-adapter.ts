export type SupportedChain = "solana";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = ["solana"];

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

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Count decoded Base58 bytes without Number precision loss. */
function isBase58ByteLength(value: string, requiredBytes: number): boolean {
  if (value.length < 1 || value.length > 128) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) {
    number >>= 8n;
    bytes++;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes++;
  }
  return bytes === requiredBytes;
}

export function isSupportedChain(value: string): value is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

export function assertSupportedChain(value: string): SupportedChain {
  if (!isSupportedChain(value)) throw new ChainValidationError(value, value, "unsupported chain");
  return value;
}

export function validateAddress(chain: SupportedChain, value: string): boolean {
  return chain === "solana" && isBase58ByteLength(value, 32);
}

export function validateTransactionHash(chain: SupportedChain, value: string): boolean {
  return chain === "solana" && isBase58ByteLength(value, 64);
}

export function normalizeAddress(chain: SupportedChain, value: string): string {
  if (!isSupportedChain(chain) || !validateAddress(chain, value)) {
    throw new ChainValidationError(chain, value, "address");
  }
  return value;
}

export function normalizeTransactionHash(chain: SupportedChain, value: string): string {
  if (!isSupportedChain(chain) || !validateTransactionHash(chain, value)) {
    throw new ChainValidationError(chain, value, "transaction hash");
  }
  return value;
}
