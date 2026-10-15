/**
 * Evidence-only Telegram relationship extraction.
 * Mentions and address co-occurrence do not establish identity, ownership or coordinated behavior.
 */
export const ANALYSIS_VERSION = 1;

export type LinkKind = "mention" | "forward" | "address";
export type TargetKind = "handle" | "channel_id" | "solana_address" | "evm_address";
export type MessageLink = { kind: LinkKind; targetKind: TargetKind; targetKey: string };

export interface RawTelegramMessage {
  id: number;
  message?: string;
  senderId?: { toString(): string };
  date?: number;
  views?: number;
  forwards?: number;
  replies?: { replies?: number };
  fwdFrom?: {
    fromId?: { className?: string; channelId?: { toString(): string } };
    fromName?: string;
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TOKEN_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const EVM_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const MENTION_RE = /(?<![\w@])@([a-zA-Z][a-zA-Z0-9_]{4,31})\b/g;
const TME_RE = /(?<![a-zA-Z0-9_.-])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{4,31})(?![\w])/gi;
const RESERVED = new Set(["joinchat", "addlist", "share", "proxy", "login", "boost", "iv"]);

export function isSolanaAddress(input: string): boolean {
  if (input.length < 32 || input.length > 44) return false;
  let bytes = [0];
  for (const char of input) {
    const value = BASE58.indexOf(char);
    if (value < 0) return false;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry = Math.floor(carry / 256);
    }
  }
  for (const char of input) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return bytes.length === 32;
}

export function extractLinks(message: RawTelegramMessage): MessageLink[] {
  const links = new Map<string, MessageLink>();
  const add = (kind: LinkKind, targetKind: TargetKind, targetKey: string) => {
    links.set(`${kind}:${targetKind}:${targetKey}`, { kind, targetKind, targetKey });
  };
  const forward = message.fwdFrom?.fromId;
  if (forward?.className === "PeerChannel" && forward.channelId) {
    const id = forward.channelId.toString();
    if (/^[1-9]\d{0,19}$/.test(id)) add("forward", "channel_id", id);
  }
  // fromName is unverified attribution: never turn it into an identity/edge.
  const text = message.message ?? "";
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[1].toLowerCase();
    if (!RESERVED.has(handle)) add("mention", "handle", handle);
  }
  for (const match of text.matchAll(TME_RE)) {
    const handle = match[1].toLowerCase();
    if (!RESERVED.has(handle)) add("mention", "handle", handle);
  }
  for (const match of text.matchAll(EVM_RE)) add("address", "evm_address", match[0].toLowerCase());
  for (const match of text.matchAll(TOKEN_RE)) {
    if (isSolanaAddress(match[0])) add("address", "solana_address", match[0]);
  }
  return [...links.values()].sort((a, b) => a.kind.localeCompare(b.kind) ||
    a.targetKind.localeCompare(b.targetKind) || a.targetKey.localeCompare(b.targetKey));
}
