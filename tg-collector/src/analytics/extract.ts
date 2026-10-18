/**
 * Evidence-only Telegram relationship extraction.
 * Mentions and address co-occurrence do not establish identity, ownership or coordinated behavior.
 */
export const ANALYSIS_VERSION = 3;

import { isSolanaAddress, normalizeTarget } from "./normalize.js";
export { isSolanaAddress } from "./normalize.js";

export type LinkKind = "mention" | "forward" | "address";
export type TargetKind = "handle" | "channel_id" | "solana_address" | "evm_address";
export type MessageLink = { kind: LinkKind; targetKind: TargetKind; targetKey: string };

export interface RawTelegramMessage {
  id: number;
  message?: string;
  senderId?: { toString(): string };
  date?: number;
  editDate?: number;
  replyToMsgId?: number;
  replyTo?: { replyToMsgId?: number | { toString(): string } };
  views?: number;
  forwards?: number;
  replies?: { replies?: number };
  fwdFrom?: {
    fromId?: { className?: string; channelId?: { toString(): string } };
    fromName?: string;
  };
  /** Future adapter: Bot API channel forwarding, not GramJS forward_from user. */
  forward_from_chat?: { id?: number | string; username?: string; type?: string };
  forward_sender_name?: string;
  forward_from?: { id?: number | string };
}

const TOKEN_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const EVM_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const MENTION_RE = /(?<![\w@])@([a-zA-Z][a-zA-Z0-9_]{4,31})\b/g;
const TME_RE = /(?<![a-zA-Z0-9_.-])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{4,31})(?![\w])/gi;

export function extractLinks(message: RawTelegramMessage): MessageLink[] {
  const links = new Map<string, MessageLink>();
  const add = (kind: LinkKind, targetKind: TargetKind, raw: string) => {
    const key = normalizeTarget(targetKind, raw);
    if (key) links.set(`${kind}:${targetKind}:${key}`, { kind, targetKind, targetKey: key });
  };
  // GramJS MTProto MessageFwdHeader.fromId: only PeerChannel is a verified channel origin.
  const forward = message.fwdFrom?.fromId;
  if (forward?.className === "PeerChannel" && forward.channelId) {
    add("forward", "channel_id", forward.channelId.toString());
  }
  // Bot API adapter only: channel/supergroup forwarding; anonymous names do not imply an identity.
  const botChat = message.forward_from_chat;
  if (botChat && (botChat.type === "channel" || botChat.type === "supergroup")) {
    if (botChat.id !== undefined) add("forward", "channel_id", String(botChat.id));
    else if (botChat.username) add("forward", "handle", botChat.username);
  }
  // forward_sender_name/fromName/forward_from are unverified/private-person attribution.
  const txt = message.message ?? "";
  for (const match of txt.matchAll(MENTION_RE)) add("mention", "handle", match[1]);
  for (const match of txt.matchAll(TME_RE)) add("mention", "handle", match[1]);
  for (const match of txt.matchAll(EVM_RE)) add("address", "evm_address", match[0]);
  for (const match of txt.matchAll(TOKEN_RE)) add("address", "solana_address", match[0]);
  return [...links.values()].sort((a,b) => a.kind.localeCompare(b.kind) ||
    a.targetKind.localeCompare(b.targetKind) || a.targetKey.localeCompare(b.targetKey));
}
