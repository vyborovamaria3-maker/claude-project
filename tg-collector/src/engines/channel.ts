import { setTimeout as sleep } from "node:timers/promises";
import { Api,type TelegramClient } from "telegram";
import bigInt from "big-integer";
import {discoverDiscussion} from "../runtime/discussion.js";
import {reactionCounts} from "../persistence/messages.js";
import { pool } from "../db.js";
import type { Job } from "../queue/jobs.js";
import { finishJob } from "../queue/jobs.js";
import { storePage } from "../persistence/pages.js";
import { catchUpFreshPosts } from "./live-during-history.js";
import { batchSize, initialLimit, maxPages } from "../runtime/config.js";
import type { RawTelegramMessage as TgMessage } from "../analytics/extract.js";
import { verifiedPublicUsername } from "../validation.js";
type Source = { identifier: string; current_username: string|null; peer_id: string|null; access_hash: string|null; last_message_id: string; history_low_message_id: string; full_history:boolean;history_complete:boolean };

export async function processJob(client: TelegramClient, job: Job, isStopping: () => boolean): Promise<void> {
  const { rows } = await pool.query<Source>(
    "SELECT identifier,current_username,peer_id,access_hash,last_message_id,history_low_message_id,full_history,history_complete FROM tg_sources WHERE id=$1", [job.source_id]);
  const source = rows[0];
  if (!source) throw new Error("Source was deleted");

  let entity: Awaited<ReturnType<TelegramClient["getEntity"]>>[number];
  try {
    // An immutable-ID-verified discovery source may have a synthetic original
    // identifier when its current public handle was previously owned by another
    // channel. Resolve its last verified handle, then still verify peer_id.
    entity = await client.getEntity(
      source.current_username ?? source.identifier);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/USERNAME_INVALID|USERNAME_NOT_OCCUPIED|PEER_ID_INVALID|CHANNEL_INVALID/i.test(text)
      || !source.peer_id || !source.access_hash) throw error;
    // A historical channel can change its public username. Reuse its verified
    // input peer rather than silently losing the source or guessing a new name.
    entity = await client.getEntity(new Api.InputPeerChannel({
      channelId: bigInt(source.peer_id), accessHash: bigInt(source.access_hash),
    }));
  }
  // A Telegram username is mutable and may be reassigned to a different channel.
  // Always pin an already-identified source to its immutable channel ID. Never
  // silently ingest someone else's posts into the previous source/evidence.
  const resolved = entity as { className?: string; id?: {toString(): string} };
  if (source.peer_id && resolved.id?.toString() !== source.peer_id) {
    if (!source.access_hash) {
      throw new Error("TG_SOURCE_IDENTITY_MISMATCH: username now belongs to another channel; saved access hash unavailable");
    }
    entity = await client.getEntity(new Api.InputPeerChannel({
      channelId: bigInt(source.peer_id), accessHash: bigInt(source.access_hash),
    }));
    const pinned = entity as { id?: {toString(): string} };
    if (pinned.id?.toString() !== source.peer_id) {
      throw new Error("TG_SOURCE_IDENTITY_MISMATCH: persisted channel identity differs from MTProto response");
    }
  }
  // Never collect from user profiles/DMs: this module is channel/group-only.
  const channel = entity as {
    className?: string; id?: {toString(): string}; title?: string; accessHash?: {toString():string};
    username?: string; usernames?: Array<{username?:string;active?:boolean}>;
  };
  if (channel.className !== "Channel") {
    throw new Error("TG_SOURCE_UNSUPPORTED: only public channels and supergroups are allowed");
  }
  const publicHandle = verifiedPublicUsername(channel);
  if (!publicHandle) {
    // Only public sources are in scope, even if GramJS can still resolve a
    // now-private channel directly from its cached username. Checking only
    // the stable-peer fallback would silently fetch private channel history.
    throw new Error("TG_SOURCE_UNSUPPORTED: source no longer has a public username");
  }
  const resolvedPeer = channel.id?.toString() ?? null;
  if (!resolvedPeer) throw new Error("TG_SOURCE_UNSUPPORTED: no immutable channel ID");
  if (!source.peer_id) {
    // Older discovery versions associated a verified Telegram peer with a
    // source through a mutable username. Therefore historic discovery
    // source_id links are NOT sufficient proof of this archive's ownership.
    const legacy = await pool.query<{has_evidence:boolean}>(`
      SELECT (s.last_message_id > 0 OR s.history_low_message_id > 0 OR
        EXISTS(SELECT 1 FROM tg_messages m WHERE m.source_id=s.id) OR
        EXISTS(SELECT 1 FROM tg_discovery_mentions dm WHERE dm.source_id=s.id) OR
        EXISTS(SELECT 1 FROM tg_jobs j WHERE j.source_id=s.id
          AND (j.high_message_id IS NOT NULL OR j.cursor_before_id IS NOT NULL
            OR j.fresh_high_message_id IS NOT NULL
            OR j.fresh_cursor_before_id IS NOT NULL)))
        AS has_evidence
      FROM tg_sources s WHERE s.id=$1`, [job.source_id]);
    if (legacy.rows[0]?.has_evidence) {
      throw new Error("TG_SOURCE_IDENTITY_UNVERIFIED: legacy source already contains evidence without a verified Telegram peer ID; manually verify before ingesting.");
    }
  }
  const duplicate = await pool.query<{id:string}>(
    "SELECT id::text FROM tg_sources WHERE peer_id=$1 AND id<>$2 LIMIT 1",
    [resolvedPeer, job.source_id]);
  if (duplicate.rowCount) {
    throw new Error("TG_SOURCE_DUPLICATE_PEER: another source already tracks Telegram channel " + resolvedPeer);
  }
  await pool.query("UPDATE tg_sources SET peer_id=$2,access_hash=COALESCE($3,access_hash),title=$4,current_username=$5 WHERE id=$1",
    [job.source_id, channel.id?.toString() ?? null, channel.accessHash?.toString() ?? null,
      channel.title ?? source.identifier, publicHandle]);

  if(source.full_history&&entity instanceof Api.Channel)await discoverDiscussion(client,job.source_id,entity);
  if (source.full_history && !source.history_complete && Number(source.last_message_id) > 0) {
    const caughtUp = await catchUpFreshPosts(client, entity, job, Number(source.last_message_id));
    if (!caughtUp) {
      // Preserve the independent historical cursor while the higher-priority
      // fresh-message interval finishes in subsequent worker turns.
      await pool.query(`UPDATE tg_jobs SET state='pending',attempts=0,locked_until=NULL,
        run_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1`, [job.id]);
      return;
    }
  }
  const recoveringHistory = source.full_history && !source.history_complete;
  const baseId = Number(job.base_message_id ?? (recoveringHistory ? 0 : source.last_message_id));
  let highId = job.high_message_id ? Number(job.high_message_id) : 0;
  let cursor = job.cursor_before_id ? Number(job.cursor_before_id) : 0;
  let scanned = job.scanned_count;

  if (!job.high_message_id) {
    const latest = await client.getMessages(entity, {limit:source.full_history?20:1});
    if(source.full_history)for(const msg of latest){
     await pool.query(`UPDATE tg_messages SET views=$3,forwards=$4,replies=$5,reactions=$6::jsonb,engagement_observed_at=now()
      WHERE source_id=$1 AND message_id=$2 AND EXISTS(SELECT 1 FROM tg_sources s CROSS JOIN tg_runtime r
       WHERE s.id=$1 AND s.enabled AND r.id=1 AND r.collection_enabled)`,[job.source_id,msg.id,msg.views??null,msg.forwards??null,msg.replies?.replies??null,JSON.stringify(reactionCounts(msg))]);
    }
    // A row with a low message ID is not proof of continuous coverage:
    // search/discovery can persist isolated old posts above huge unscanned gaps.
    // Only a committed tg_jobs page cursor proves progress within a scan.
    // Restart any new history scan from the newest accessible Telegram post.
    highId = latest[0]?.id ?? 0;
    const checkpoint = await pool.connect();
    try {
      await checkpoint.query("BEGIN");
      await checkpoint.query(
        "UPDATE tg_jobs SET base_message_id=$2,high_message_id=$3,updated_at=now() WHERE id=$1",
        [job.id, baseId, highId]);
      if (recoveringHistory && Number(source.last_message_id) === 0 && highId > 0) {
        // An observed upper bound allows priority fresh-message checks while
        // historical pages are still being persisted below that boundary.
        await checkpoint.query(
          "UPDATE tg_sources SET last_message_id=GREATEST(last_message_id,$2) WHERE id=$1",
          [job.source_id, highId]);
      }
      await checkpoint.query("COMMIT");
    } catch (error) {
      await checkpoint.query("ROLLBACK"); throw error;
    } finally {checkpoint.release();}
  }

  if (highId <= baseId) {
    await finishJob(job, Math.max(baseId, highId), false,baseId);
    return;
  }

  const pagesPerTurn=source.full_history?Math.min(maxPages,2):maxPages;
  for (let page=0; page<pagesPerTurn && !isStopping(); page++) {
    const activeSource = await pool.query<{enabled:boolean}>(`SELECT s.enabled AND r.collection_enabled AND r.block_reason IS NULL
      AND (r.pause_until IS NULL OR r.pause_until <= now()) AS enabled
      FROM tg_sources s CROSS JOIN tg_runtime r WHERE s.id=$1 AND r.id=1`, [job.source_id]);
    if (!activeSource.rows[0]?.enabled) {
      await pool.query("UPDATE tg_jobs SET state='pending', locked_until=NULL, run_at=now()+interval '5 seconds' WHERE id=$1", [job.id]);
      return;
    }
    const batch = await client.getMessages(entity, {
      limit: batchSize,
      offsetId: cursor || highId+1,
      minId: baseId,
    });
    const messages = batch as unknown as TgMessage[];
    if (!messages.length) {
      await finishJob(job, highId, false,baseId);
      console.log("Synced", source.identifier, "to", highId);
      return;
    }
    const lowId = Math.min(...messages.map(m=>m.id));
    if (!Number.isFinite(lowId) || (cursor && lowId >= cursor)) {
      throw new Error("Telegram history cursor did not advance");
    }
    await storePage(job, messages, lowId);
    cursor=lowId;
    scanned+=messages.length;
    const initialCutoff = !source.full_history && baseId === 0 && scanned >= initialLimit;
    // A short Telegram page is not proof that the history ended: deleted or
    // inaccessible message IDs can produce short batches before older posts.
    // Only an empty page proves exhaustion of the requested history interval.
    if (initialCutoff) {
      await finishJob(job, highId, true, baseId);
      console.log("Synced", source.identifier, messages.length, "latest batch", "high", highId);
      return;
    }
    await sleep(250);
  }
  // The checkpoint is not advanced until the whole new-message range is captured.
  await pool.query(`UPDATE tg_jobs SET state='pending',
    attempts=0, locked_until=NULL, run_at=now()+interval '5 seconds',
    updated_at=now() WHERE id=$1`, [job.id]);
}


