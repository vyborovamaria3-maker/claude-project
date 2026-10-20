import {
  buildEntityRef, type EntityRef,
} from "./entity-registry.js";
import type { EvidenceRef } from "./evidence.js";
import { formatTokenId, type TokenId } from "./canonical-ids.js";
import { toUtcIso } from "./time.js";

/**
 * Evidence-qualified historical link observation. This is NOT an active
 * token association, trade, ownership claim or permission to backfill PnL.
 * Mutable active/retracted state requires a separate reviewed materializer.
 */
export type VerifiedTokenLink = {
  status: "verified";
  canonicalTokenId: TokenId;
  basis: "literal_mint_address";
  sourceRevisionSha256: string;
  mintVerification: {
    chainId: "solana-mainnet";
    method: "spl_mint_account";
    tokenProgram: string;
    provider: string;
    checkedAt: string;
  };
};
export type VerifiedTokenLinkEvent = {
  sourceSystem: "x" | "tg";
  eventKind: "token_link_verified";
  eventKey: string;
  schemaVersion: "token-link-v1";
  payload: {
    registryEvent: {
      sourceSystem: "x" | "tg"; eventKind: "token_link_verified";
      eventKey: string; schemaVersion: "token-link-v1";
      entityRefs: EntityRef[]; evidenceRef: EvidenceRef;
    };
    tokenLink: VerifiedTokenLink;
  };
};

export const SOLANA_TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function buildVerifiedTokenLinkEvent(input: {
  sourceSystem: "x" | "tg";
  sourceEntity: EntityRef;
  evidenceRef: EvidenceRef;
  mint: string;
  sourceRevisionSha256: string;
  mintVerification: {
    chainId: "solana-mainnet";
    method: "spl_mint_account";
    tokenProgram: string;
    provider: string;
    checkedAt: Date | string;
  };
  /** Caller MUST have matched the mint literally in source text / evidence. */
  matchedLiteralMint: string;
}): VerifiedTokenLinkEvent {
  if (input.sourceSystem !== "x" && input.sourceSystem !== "tg") {
    throw new TypeError("Unsupported social source");
  }
  const expectedEntityKind=input.sourceSystem==="x"?"author":"source";
  if (input.sourceEntity.kind!==expectedEntityKind ||
      !input.sourceEntity.canonicalId.startsWith(input.sourceSystem+":")) {
    throw new TypeError("Source entity kind or platform mismatch");
  }
  const ref=buildEntityRef(input.sourceEntity);
  const evidence=input.evidenceRef;
  if (!evidence || (input.sourceSystem==="x" && evidence.sourceKind!=="x_tweet") ||
      (input.sourceSystem==="tg" && evidence.sourceKind!=="tg_message")) {
    throw new TypeError("Social evidence mismatch");
  }
  // Normalize clocks, preserve the canonical evidence ID from the source.
  const observedAt=toUtcIso(evidence.observedAt);
  const occurredAt=evidence.occurredAt===undefined?undefined:toUtcIso(evidence.occurredAt);
  const ev:EvidenceRef={
    ...evidence,observedAt,
    ...(occurredAt===undefined?{}:{occurredAt}),
  };
  const expectedSourceId = input.sourceSystem==="x"
    ? /^x:tweet:[1-9][0-9]*$/
    : /^tg:message:-?(?:0|[1-9][0-9]*):[1-9][0-9]*$/;
  if (!expectedSourceId.test(ev.sourceId)) throw new TypeError("Invalid source evidence ID");
  if (!SHA256.test(input.sourceRevisionSha256)) throw new TypeError("Expected source revision SHA256");
  const v=input.mintVerification;
  if (!v || v.chainId!=="solana-mainnet" || v.method!=="spl_mint_account" ||
      !SOLANA_TOKEN_PROGRAMS.includes(v.tokenProgram as typeof SOLANA_TOKEN_PROGRAMS[number]) ||
      !SAFE_PROVIDER.test(v.provider)) throw new TypeError("Verified SPL mint account required");
  const checkedAt=toUtcIso(v.checkedAt);
  if (checkedAt>observedAt) throw new TypeError("Mint verification cannot occur after link observation");
  const canonicalTokenId=formatTokenId("solana",input.mint);
  if (input.matchedLiteralMint!==input.mint) {
    throw new TypeError("Exact literal mint match required");
  }
  const tokenRef=buildEntityRef({
    kind:"token",canonicalId:canonicalTokenId,
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  });
  // Each re-verified observation is immutable and replay-safe; token and
  // content revision are encoded into the event key, not mutable usernames.
  const eventKey=`${input.sourceSystem}:tokenlink:${ev.sourceId}:${input.mint}:${input.sourceRevisionSha256}:${Date.parse(checkedAt)}`;
  if(eventKey.length>512)throw new TypeError("Token link event key is too long");
  const registryEvent={
    sourceSystem:input.sourceSystem,eventKind:"token_link_verified" as const,
    eventKey,schemaVersion:"token-link-v1" as const,
    entityRefs:[ref,tokenRef],evidenceRef:ev,
  };
  return {
    sourceSystem:input.sourceSystem,eventKind:"token_link_verified",eventKey,
    schemaVersion:"token-link-v1",
    payload:{
      registryEvent,
      tokenLink:{
        status:"verified",canonicalTokenId,basis:"literal_mint_address",
        sourceRevisionSha256:input.sourceRevisionSha256,
        mintVerification:{
          chainId:"solana-mainnet",method:"spl_mint_account",
          tokenProgram:v.tokenProgram,provider:v.provider,checkedAt,
        },
      },
    },
  };
}

/**
 * Receiver-side structural validation. Only the native source RPC resolver
 * can establish that the source text and on-chain account were really seen;
 * this check prevents malformed/inconsistent outbox envelopes. It does NOT
 * independently contact an RPC or read private message text.
 */
export function validateVerifiedTokenLinkEvent(input: unknown): VerifiedTokenLinkEvent {
  if (!input || typeof input!=="object" || Array.isArray(input))
    throw new TypeError("Invalid token link event");
  const raw=input as VerifiedTokenLinkEvent;
  if (!["x","tg"].includes(raw.sourceSystem) ||
      raw.eventKind!=="token_link_verified" ||
      raw.schemaVersion!=="token-link-v1" ||
      !raw.payload || !raw.payload.registryEvent || !raw.payload.tokenLink) {
    throw new TypeError("Invalid token link envelope");
  }
  const link=raw.payload.tokenLink,reg=raw.payload.registryEvent;
  if (link.status!=="verified" || link.basis!=="literal_mint_address" ||
      reg.sourceSystem!==raw.sourceSystem || reg.eventKind!==raw.eventKind ||
      reg.schemaVersion!==raw.schemaVersion || reg.eventKey!==raw.eventKey ||
      !Array.isArray(reg.entityRefs) || reg.entityRefs.length!==2) {
    throw new TypeError("Invalid token link attribution");
  }
  const mint=link.canonicalTokenId?.startsWith("solana:")
    ? link.canonicalTokenId.slice("solana:".length) : "";
  const expected=buildVerifiedTokenLinkEvent({
    sourceSystem:raw.sourceSystem,
    sourceEntity:reg.entityRefs[0]!,
    evidenceRef:reg.evidenceRef,
    mint,matchedLiteralMint:mint,
    sourceRevisionSha256:link.sourceRevisionSha256,
    mintVerification:link.mintVerification,
  });
  if (raw.eventKey!==expected.eventKey ||
      JSON.stringify(reg.entityRefs)!==JSON.stringify(expected.payload.registryEvent.entityRefs) ||
      JSON.stringify(reg.evidenceRef)!==JSON.stringify(expected.payload.registryEvent.evidenceRef) ||
      JSON.stringify(link)!==JSON.stringify(expected.payload.tokenLink)) {
    throw new TypeError("Inconsistent verified token link evidence");
  }
  return raw;
}
