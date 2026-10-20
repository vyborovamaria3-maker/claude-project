import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { RawTelegramMessage } from "../analytics/extract.js";
import { isSolanaAddress } from "../analytics/normalize.js";

/**
 * Source-side opt-in. The source's native migration runs by default but the
 * producer remains inactive until an Intelligence consumer is provisioned.
 */
export function telegramOutboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TG_INTELLIGENCE_OUTBOX_ENABLED === "true";
}

// Telegram channel identifiers may be signed (e.g. -100123). Preserve the
// sign exactly; never infer or strip it from a mutable @username.
const STABLE_PEER = /^-?[1-9][0-9]{0,19}$/;
function stablePeer(peerId: string | null): string {
  if (!peerId || !STABLE_PEER.test(peerId)) {
    throw new Error("TG_INTELLIGENCE_PEER_UNRESOLVED: stable numeric channel peer_id required");
  }
  return peerId;
}
function utcObserved(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid Telegram observedAt");
  }
  return date.toISOString();
}

/**
 * No raw Telegram text or forwarded session/account credential is placed in
 * the outbox payload. Only a hash identifies the observed message revision.
 * Address candidates are NOT treated as verified tokens.
 */
export function buildTgOutboxEvent(
  peerId: string | null, message: RawTelegramMessage, now = new Date(),
): {sourceSystem:string;eventKind:string;eventKey:string;schemaVersion:string;payload:Record<string,unknown>} {
  const peer = stablePeer(peerId);
  if (!Number.isSafeInteger(message.id) || message.id <= 0 || typeof message.message !== "string") {
    throw new TypeError("Invalid Telegram message");
  }
  const observedAt=utcObserved(now);
  const published = typeof message.date === "number" && Number.isFinite(message.date)
    ? new Date(message.date * 1000) : null;
  const occurredAt = published && Number.isFinite(published.getTime())
    ? published.toISOString() : observedAt;
  const revision = createHash("sha256").update(JSON.stringify([
    message.message,message.date ?? null,message.editDate ?? null,
    message.views ?? null,message.forwards ?? null,message.replies?.replies ?? null,
  ])).digest("hex");
  const eventKey=`tg:${peer}:${message.id}:rev:${revision}`;
  const sourceId=`tg:source:${peer}`;
  const evidenceRef={
    sourceKind:"tg_message",sourceId:`tg:message:${peer}:${message.id}`,
    observedAt,occurredAt,parserVersion:"tg-mtproto-v1",
  };
  const entityRefs=[{kind:"source",canonicalId:sourceId,
    firstSeenAt:observedAt,lastSeenAt:observedAt}];
  return {
    sourceSystem:"tg",eventKind:"message_observed",eventKey,
    schemaVersion:"tg-message-v1",
    payload:{
      registryEvent:{
        sourceSystem:"tg",eventKind:"message_observed",eventKey,
        schemaVersion:"tg-message-v1",entityRefs,evidenceRef,
      },
      timelineEvent:{
        schemaVersion:"timeline-v1",eventKey,kind:"tg_message_published",
        occurredAt,observedAt,entityRefs,evidenceRef,payload:{},
      },
    },
  };
}

/** The source client must already be inside the SAME transaction as tg_messages. */
export async function emitTgMessageOutbox(
  tx: PoolClient, sourceId: string, message: RawTelegramMessage,
  now = new Date(),
): Promise<void> {
  if (!telegramOutboxEnabled()) return;
  const {rows} = await tx.query<{peer_id:string|null}>(
    "SELECT peer_id FROM tg_sources WHERE id=$1 FOR KEY SHARE",[sourceId]);
  const event=buildTgOutboxEvent(rows[0]?.peer_id??null,message,now);
  await insertOutbox(tx,event);
}

export function buildTgDeletionOutboxEvent(
  peerId: string|null, messageId: number, now = new Date(), deletionRevision = now.toISOString(),
) {
  const peer=stablePeer(peerId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new TypeError("Invalid Telegram message ID");
  }
  const observedAt=utcObserved(now);
  // A message can be restored/re-observed and deleted more than once.
  // Use the exact PostgreSQL deletion revision, not a constant message key.
  if (typeof deletionRevision !== "string" || !deletionRevision.trim() || deletionRevision.length > 128) {
    throw new TypeError("Invalid deletion revision");
  }
  const revisionHash=createHash("sha256").update(deletionRevision).digest("hex");
  const eventKey=`tg:${peer}:${messageId}:deleted:rev:${revisionHash}`;
  const entityRefs=[{kind:"source",canonicalId:`tg:source:${peer}`,
    firstSeenAt:observedAt,lastSeenAt:observedAt}];
  return {
    sourceSystem:"tg",eventKind:"message_deleted",eventKey,
    schemaVersion:"tg-message-v1",
    payload:{registryEvent:{
      sourceSystem:"tg",eventKind:"message_deleted",eventKey,
      schemaVersion:"tg-message-v1",entityRefs,
      evidenceRef:{sourceKind:"tg_message",
        sourceId:`tg:message:${peer}:${messageId}`,observedAt},
    }},
  };
}

/** Retain original message evidence even after a soft delete. */
export async function emitTgDeletionOutbox(
  tx:PoolClient,sourceId:string,messageId:number,now=new Date(),deletionRevision=now.toISOString(),
):Promise<void> {
  if (!telegramOutboxEnabled()) return;
  const {rows}=await tx.query<{peer_id:string|null}>(
    "SELECT peer_id FROM tg_sources WHERE id=$1 FOR KEY SHARE",[sourceId]);
  await insertOutbox(tx,buildTgDeletionOutboxEvent(rows[0]?.peer_id??null,messageId,now,deletionRevision));
}

async function insertOutbox(
  tx:PoolClient,
  event:{sourceSystem:string;eventKind:string;eventKey:string;schemaVersion:string;payload:Record<string,unknown>},
):Promise<void> {
  await tx.query(`INSERT INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT (source_system,event_kind,event_key) DO NOTHING`,[
      event.sourceSystem,event.eventKind,event.eventKey,
      event.schemaVersion,JSON.stringify(event.payload),
    ]);
}

const VERIFIED_TOKEN_PROGRAMS=new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

/** Separate opt-in gate for mint links; native Telegram and source Outbox stay independent. */
export function telegramVerifiedTokenLinksEnabled(env: NodeJS.ProcessEnv=process.env):boolean {
  return telegramOutboxEnabled(env) && env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED==="true";
}

/**
 * A verified token link is a HISTORICAL evidence observation, not an active
 * token-to-message membership or a token timeline entry. The destination
 * cannot assume it remains current after an edit/delete until ARCH-07.
 * No raw Telegram content is ever included in the emitted payload.
 */
export function buildVerifiedTgTokenLinkOutboxEvent(input:{
  peerId:string|null; messageId:string; text:string; mint:string;
  tokenProgram:string; provider:"alchemy-solana-rpc";
  sourceRevisionSha256:string; observedAt:Date; postedAt:Date|null;
}) {
  const peer=stablePeer(input.peerId);
  if(!/^[1-9][0-9]*$/.test(input.messageId) ||
     !isSolanaAddress(input.mint) || !VERIFIED_TOKEN_PROGRAMS.has(input.tokenProgram) ||
     input.provider!=="alchemy-solana-rpc" ||
     !/^[a-f0-9]{64}$/.test(input.sourceRevisionSha256) ||
     typeof input.text!=="string") {
    throw new TypeError("Invalid verified Telegram mint evidence");
  }
  // Require a literal token boundary. A ticker, substring or mere address
  // existence never qualifies as on-chain-verified evidence.
  const exactMint=new RegExp("(?<![1-9A-HJ-NP-Za-km-z])"+input.mint+"(?![1-9A-HJ-NP-Za-km-z])");
  if(!exactMint.test(input.text))throw new TypeError("Mint not literally present in current message");
  const observedAt=utcObserved(input.observedAt);
  const occurredAt=input.postedAt?utcObserved(input.postedAt):observedAt;
  const evidenceRef={
    sourceKind:"tg_message",sourceId:`tg:message:${peer}:${input.messageId}`,
    observedAt,occurredAt,parserVersion:"tg-mint-verifier-v1",
  };
  const tokenId="solana:"+input.mint;
  const entityRefs=[
    {kind:"source",canonicalId:`tg:source:${peer}`,firstSeenAt:observedAt,lastSeenAt:observedAt},
    {kind:"token",canonicalId:tokenId,firstSeenAt:observedAt,lastSeenAt:observedAt},
  ];
  const eventKey=`tg:tokenlink:${evidenceRef.sourceId}:${input.mint}:${input.sourceRevisionSha256}:${input.observedAt.getTime()}`;
  return {
    sourceSystem:"tg",eventKind:"token_link_verified",eventKey,
    schemaVersion:"token-link-v1",
    payload:{
      registryEvent:{
        sourceSystem:"tg",eventKind:"token_link_verified",
        eventKey,schemaVersion:"token-link-v1",entityRefs,evidenceRef,
      },
      tokenLink:{
        status:"verified",canonicalTokenId:tokenId,basis:"literal_mint_address",
        sourceRevisionSha256:input.sourceRevisionSha256,
        mintVerification:{
          chainId:"solana-mainnet",method:"spl_mint_account",
          tokenProgram:input.tokenProgram,provider:input.provider,checkedAt:observedAt,
        },
      },
    },
  };
}

/** Caller must own the same transaction that confirms the on-chain mint. */
export async function emitVerifiedTgTokenLinkOutbox(tx:PoolClient,input:Parameters<typeof buildVerifiedTgTokenLinkOutboxEvent>[0]):Promise<boolean>{
  if(!telegramVerifiedTokenLinksEnabled())return false;
  const event=buildVerifiedTgTokenLinkOutboxEvent(input);
  await insertOutbox(tx,event);
  return true;
}

/** A source-level tombstone invalidates ALL previously verified mints for this
 * exact message evidence, not just the mint currently visible after an edit. */
export function buildTgTokenLinksInvalidatedOutboxEvent(input:{
  peerId:string|null;messageId:number;reason:"edited"|"deleted";
  sourceRevisionSha256:string;observedAt:Date;postedAt:Date|null;
}){
  const peer=stablePeer(input.peerId);
  if(!Number.isSafeInteger(input.messageId)||input.messageId<=0||
     !["edited","deleted"].includes(input.reason)||
     !/^[a-f0-9]{64}$/.test(input.sourceRevisionSha256)){
    throw new TypeError("Invalid Telegram token-link invalidation");
  }
  const observedAt=utcObserved(input.observedAt);
  const occurredAt=input.postedAt?utcObserved(input.postedAt):observedAt;
  const sourceId=`tg:message:${peer}:${input.messageId}`;
  const eventKey=`tg:tokenlinks:invalidate:${sourceId}:${input.reason}:${input.sourceRevisionSha256}:${input.observedAt.getTime()}`;
  return {
    sourceSystem:"tg",eventKind:"token_links_invalidated",eventKey,
    schemaVersion:"token-link-v1",
    payload:{
      registryEvent:{
        sourceSystem:"tg",eventKind:"token_links_invalidated",eventKey,
        schemaVersion:"token-link-v1",
        entityRefs:[{kind:"source",canonicalId:`tg:source:${peer}`,
          firstSeenAt:observedAt,lastSeenAt:observedAt}],
        evidenceRef:{sourceKind:"tg_message",sourceId,
          observedAt,occurredAt,parserVersion:"tg-mint-verifier-v1"},
      },
      tokenLinksInvalidation:{
        status:"invalidated",reason:input.reason,
        sourceRevisionSha256:input.sourceRevisionSha256,
      },
    },
  };
}

/** Must be called inside the same source transaction as the edit/deletion. */
export async function emitTgTokenLinksInvalidation(
  tx:PoolClient, sourceId:string,
  input:Omit<Parameters<typeof buildTgTokenLinksInvalidatedOutboxEvent>[0],"peerId">,
):Promise<boolean>{
  // Do not gate tombstones on NEW link assertions: previously published
  // claims still require edit/delete revocation while source Outbox is on.
  if(!telegramOutboxEnabled())return false;
  const peer=await tx.query<{peer_id:string|null}>(
    "SELECT peer_id FROM tg_sources WHERE id=$1 FOR KEY SHARE",[sourceId]);
  const event=buildTgTokenLinksInvalidatedOutboxEvent({
    ...input,peerId:peer.rows[0]?.peer_id??null,
  });
  await insertOutbox(tx,event);
  return true;
}
