import type { TargetKind } from "./extract.js";

/** Canonical identifiers; chain-format validation does NOT identify a contract or owner. */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BLOCKED_HANDLES = new Set(["joinchat", "addlist", "share", "proxy", "login", "boost", "iv"]);

export function isSolanaAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const bytes: number[] = [0];
  for (const character of value) {
    let carry = BASE58.indexOf(character);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry = Math.floor(carry / 256);
    }
    while (carry) { bytes.push(carry & 255); carry = Math.floor(carry / 256); }
  }
  for (const c of value) { if (c === "1") bytes.push(0); else break; }
  return bytes.length === 32;
}

export function normalizeTarget(kind: TargetKind, input: string): string | null {
  const value = input.trim();
  if (kind === "handle") {
    const match = value.match(/^(?:@|(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/)?([a-zA-Z][a-zA-Z0-9_]{4,31})(?:\/\d+)?\/?$/i);
    if (!match) return null;
    const handle = match[1].toLowerCase();
    return BLOCKED_HANDLES.has(handle) ? null : handle;
  }
  if (kind === "channel_id") {
    // GramJS channelId is an unsigned decimal string; Bot API uses -100<channelId>.
    const digits = /^-100[1-9]\d*$/.test(value) ? value.slice(4) : value;
    if (!/^[1-9]\d{0,19}$/.test(digits)) return null;
    return digits;
  }
  if (kind === "evm_address") {
    // Do not infer missing prefixes or try to complete visually truncated addresses.
    return /^0x[\da-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
  }
  if (kind === "solana_address") return isSolanaAddress(value) ? value : null;
  return null;
}
