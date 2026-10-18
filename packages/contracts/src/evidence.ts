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
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function optionalMetadata(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > 4096) throw new TypeError("Invalid " + label);
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
      if (input.chain === "solana") {
        if (!isSolanaSignature(input.transactionId)) throw new TypeError("Invalid Solana transaction signature");
        sourceId = "chain:tx:solana:" + input.transactionId;
      } else {
        if (!EVM_TX_HASH.test(input.transactionId)) throw new TypeError("Invalid EVM transaction hash");
        sourceId = "chain:tx:" + input.chain + ":" + input.transactionId.toLowerCase();
      }
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
