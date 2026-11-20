import {
  formatSourceId, isChain, isSolanaSignature,
  type Chain,
} from "./canonical-ids.js";
import { toUtcIso } from "./time.js";

export type EvidenceSourceKind = "x_tweet" | "tg_message" | "chain_tx";
export type EvidenceRef = {
  sourceKind: EvidenceSourceKind;
  sourceId: string;
  observedAt: string;
  occurredAt?: string;
  provider?: string;
  parserVersion?: string;
  rawPointer?: string;
};

type EvidenceMetadata = {
  observedAt: Date | string;
  occurredAt?: Date | string;
  provider?: string;
  parserVersion?: string;
  rawPointer?: string;
};

export type EvidenceInput = EvidenceMetadata & (
  | { sourceKind: "x_tweet"; tweetId: string }
  | { sourceKind: "tg_message"; sourceAccountId: string; messageId: string }
  | { sourceKind: "chain_tx"; chain: Chain; transactionId: string }
);

const POSITIVE_ID = /^[1-9][0-9]*$/;

function optionalMetadata(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new TypeError("Invalid " + label);
  }
  return value;
}

export function buildEvidenceRef(input: EvidenceInput): EvidenceRef {
  let sourceId: string;
  switch (input.sourceKind) {
    case "x_tweet":
      if (!POSITIVE_ID.test(input.tweetId)) throw new TypeError("Tweet ID must be a positive decimal string");
      sourceId = "x:tweet:" + input.tweetId;
      break;
    case "tg_message": {
      if (!POSITIVE_ID.test(input.messageId)) throw new TypeError("Message ID must be a positive decimal string");
      const source = formatSourceId("tg", input.sourceAccountId);
      sourceId = "tg:message:" + source.slice("tg:source:".length) + ":" + input.messageId;
      break;
    }
    case "chain_tx":
      if (!isChain(input.chain)) throw new TypeError("Invalid chain");
      if (!isSolanaSignature(input.transactionId)) {
        throw new TypeError("Invalid Solana transaction signature");
      }
      sourceId = "chain:tx:solana:" + input.transactionId;
      break;
    default:
      throw new TypeError("Invalid evidence source");
  }
  return {
    sourceKind: input.sourceKind,
    sourceId,
    observedAt: toUtcIso(input.observedAt),
    ...(input.occurredAt !== undefined ? { occurredAt: toUtcIso(input.occurredAt) } : {}),
    ...(input.provider !== undefined ? { provider: optionalMetadata(input.provider, "provider") } : {}),
    ...(input.parserVersion !== undefined ? { parserVersion: optionalMetadata(input.parserVersion, "parserVersion") } : {}),
    ...(input.rawPointer !== undefined ? { rawPointer: optionalMetadata(input.rawPointer, "rawPointer") } : {}),
  };
}

/** Validate an untrusted wire EvidenceRef and return its canonical representation. */
export function validateEvidenceRef(input: unknown): EvidenceRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid evidence reference");
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set([
    "sourceKind", "sourceId", "observedAt", "occurredAt",
    "provider", "parserVersion", "rawPointer",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new TypeError("Unknown evidence field: " + key);
  }
  if (typeof raw.sourceId !== "string" || raw.sourceId.length > 512 ||
      typeof raw.observedAt !== "string") {
    throw new TypeError("Invalid evidence identity or observation clock");
  }
  for (const key of ["occurredAt", "provider", "parserVersion", "rawPointer"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      throw new TypeError("Invalid evidence field: " + key);
    }
  }
  const metadata: EvidenceMetadata = {
    observedAt: raw.observedAt,
    ...(raw.occurredAt === undefined ? {} : { occurredAt: raw.occurredAt as string }),
    ...(raw.provider === undefined ? {} : { provider: raw.provider as string }),
    ...(raw.parserVersion === undefined ? {} : { parserVersion: raw.parserVersion as string }),
    ...(raw.rawPointer === undefined ? {} : { rawPointer: raw.rawPointer as string }),
  };

  if (raw.sourceKind === "x_tweet") {
    const match = /^x:tweet:([1-9][0-9]*)$/.exec(raw.sourceId);
    if (!match) throw new TypeError("Invalid X tweet evidence ID");
    return buildEvidenceRef({ ...metadata, sourceKind: "x_tweet", tweetId: match[1]! });
  }
  if (raw.sourceKind === "tg_message") {
    const match = /^tg:message:(-?(?:[1-9][0-9]*)):([1-9][0-9]*)$/.exec(raw.sourceId);
    if (!match) throw new TypeError("Invalid Telegram message evidence ID");
    return buildEvidenceRef({
      ...metadata, sourceKind: "tg_message",
      sourceAccountId: match[1]!, messageId: match[2]!,
    });
  }
  if (raw.sourceKind === "chain_tx") {
    const match = /^chain:tx:solana:([1-9A-HJ-NP-Za-km-z]+)$/.exec(raw.sourceId);
    if (!match || !isSolanaSignature(match[1])) {
      throw new TypeError("Invalid Solana transaction evidence ID");
    }
    return buildEvidenceRef({
      ...metadata, sourceKind: "chain_tx", chain: "solana",
      transactionId: match[1]!,
    });
  }
  throw new TypeError("Unsupported evidence source kind");
}
