import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { RawTelegramMessage } from "../analytics/extract.js";

/**
 * Source-side opt-in. The source's native migration runs by default but the
 * producer remains inactive until an Intelligence consumer is provisioned.
 */
export function telegramOutboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TG_INTELLIGENCE_OUTBOX_ENABLED === "true";
}

const STABLE_PEER = /^[1-9][0-9]{0,19}$/;
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
