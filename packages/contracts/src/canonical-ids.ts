/**
 * Durable, wire-safe entity identity. Chain identity is explicit; ticker symbols,
 * X handles and Telegram usernames are NOT stable primary keys.
 *
 * Runtime validators deliberately reject placeholder/truncated addresses.
 * Solana public keys are Base58 and case-sensitive; EVM addresses use full
 * 20-byte hex and are normalized to lowercase.
 */
export const CHAINS = ["solana", "ethereum", "base", "arbitrum"] as const;
export type Chain = (typeof CHAINS)[number];
export type SocialPlatform = "x" | "tg";

declare const tokenIdBrand: unique symbol;
declare const walletIdBrand: unique symbol;
declare const authorIdBrand: unique symbol;
declare const sourceIdBrand: unique symbol;

export type TokenId = string & { readonly [tokenIdBrand]: true };
export type WalletId = string & { readonly [walletIdBrand]: true };
export type AuthorId = string & { readonly [authorIdBrand]: true };
export type SourceId = string & { readonly [sourceIdBrand]: true };

export type ParsedChainId = { chain: Chain; address: string };
export type ParsedAuthorId = { platform: SocialPlatform; accountId: string };
export type ParsedSourceId = { platform: SocialPlatform; accountId: string };

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
const TG_DIGITS = /^-?(0|[1-9][0-9]*)$/;

export function isChain(value: unknown): value is Chain {
  return typeof value === "string" && (CHAINS as readonly string[]).includes(value);
}

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

export function isSolanaPublicKey(value: unknown): value is string {
  return typeof value === "string" && isBase58ByteLength(value, 32);
}

export function isSolanaSignature(value: unknown): value is string {
  return typeof value === "string" && isBase58ByteLength(value, 64);
}

export function normalizeAddress(chain: Chain, address: unknown): string {
  if (!isChain(chain)) throw new TypeError("Unsupported chain");
  if (typeof address !== "string") throw new TypeError("Address must be a string");
  if (chain === "solana") {
    if (!isSolanaPublicKey(address)) throw new TypeError("Invalid Solana 32-byte Base58 public key");
    return address;
  }
  if (!EVM_ADDRESS.test(address)) throw new TypeError("Invalid EVM 20-byte 0x address");
  return address.toLowerCase();
}

export const normalizeMint = normalizeAddress;

function parseChainAddress(input: unknown): ParsedChainId | null {
  if (typeof input !== "string") return null;
  const delimiter = input.indexOf(":");
  if (delimiter <= 0 || delimiter === input.length - 1 || input.indexOf(":", delimiter + 1) !== -1) return null;
  const prefix = input.slice(0, delimiter);
  if (!isChain(prefix)) return null;
  try {
    return { chain: prefix, address: normalizeAddress(prefix, input.slice(delimiter + 1)) };
  } catch {
    return null;
  }
}

export function formatTokenId(chain: Chain, mint: string): TokenId {
  return (chain + ":" + normalizeAddress(chain, mint)) as TokenId;
}

export function parseTokenId(input: unknown): (ParsedChainId & { id: TokenId; mint: string }) | null {
  const parsed = parseChainAddress(input);
  if (!parsed) return null;
  return {
    ...parsed,
    mint: parsed.address,
    id: formatTokenId(parsed.chain, parsed.address),
  };
}

export function validateTokenId(input: unknown): input is TokenId {
  return typeof input === "string" && parseTokenId(input)?.id === input;
}

export function formatWalletId(chain: Chain, address: string): WalletId {
  return (chain + ":" + normalizeAddress(chain, address)) as WalletId;
}

export function parseWalletId(input: unknown): (ParsedChainId & { id: WalletId }) | null {
  const parsed = parseChainAddress(input);
  return parsed ? { ...parsed, id: formatWalletId(parsed.chain, parsed.address) } : null;
}

function validateAccountId(platform: SocialPlatform, accountId: unknown): string {
  if (typeof accountId !== "string") throw new TypeError("Account ID must be a string");
  if (platform === "x" && DIGITS.test(accountId)) return accountId;
  if (platform === "tg" && TG_DIGITS.test(accountId)) return accountId;
  throw new TypeError("Stable numeric X/TG account ID required; do not use a handle");
}

export function formatAuthorId(platform: SocialPlatform, accountId: string): AuthorId {
  return (platform + ":" + validateAccountId(platform, accountId)) as AuthorId;
}

export function parseAuthorId(input: unknown): (ParsedAuthorId & { id: AuthorId }) | null {
  if (typeof input !== "string") return null;
  const match = /^(x|tg):(-?[0-9]+)$/.exec(input);
  if (!match) return null;
  const platform = match[1] as SocialPlatform;
  const accountId = match[2] as string;
  try {
    return { platform, accountId, id: formatAuthorId(platform, accountId) };
  } catch {
    return null;
  }
}

/**
 * Source identity uses numeric account/channel IDs instead of mutable handles.
 * X: x:account:123; Telegram: tg:source:-100123.
 */
export function formatSourceId(platform: SocialPlatform, accountId: string): SourceId {
  const role = platform === "x" ? "account" : "source";
  return (platform + ":" + role + ":" + validateAccountId(platform, accountId)) as SourceId;
}

export function parseSourceId(input: unknown): (ParsedSourceId & { id: SourceId }) | null {
  if (typeof input !== "string") return null;
  const match = /^(x:account|tg:source):(-?[0-9]+)$/.exec(input);
  if (!match) return null;
  const platform: SocialPlatform = match[1] === "x:account" ? "x" : "tg";
  const accountId = match[2] as string;
  try {
    return { platform, accountId, id: formatSourceId(platform, accountId) };
  } catch {
    return null;
  }
}
