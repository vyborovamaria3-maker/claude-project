import "dotenv/config";
import { Api, type TelegramClient } from "telegram";
import bigInt from "big-integer";
import { pool, migrate } from "../db.js";
import { authorizedClient } from "../accounts/session.js";
import { normalizePublicUsername } from "../validation.js";
import { persistMessage } from "../persistence/messages.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import type { RawTelegramMessage } from "../analytics/extract.js";

async function main(): Promise<void> {
  const handle = normalizePublicUsername(process.argv[2] ?? "");
  const limitInput = process.argv.find(arg => arg.startsWith("--limit="));
  const limit = Number(limitInput?.slice("--limit=".length) ?? "200");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("--limit must be between 1 and 500");
  await migrate();
  const guard = await pool.connect();
  let client: TelegramClient | undefined;
  try {
    const lock = await guard.query<{acquired:boolean}>("SELECT pg_try_advisory_lock(8260226) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error("Stop the Telegram worker before refetching message entities.");
    const sources = await pool.query<{
      id:string;identifier:string;peer_id:string|null;access_hash:string|null;
    }>(`SELECT id::text,identifier,peer_id,access_hash FROM tg_sources
      WHERE identifier=$1 OR current_username=$1 ORDER BY (current_username=$1) DESC LIMIT 2`,[handle]);
    if (sources.rowCount !== 1) throw new Error("Missing or ambiguous source for @" + handle);
    const source = sources.rows[0];
    if (!source.peer_id) throw new Error("Source must have a verified immutable Telegram peer ID first.");

    client = await authorizedClient();
    let entity: Awaited<ReturnType<TelegramClient["getEntity"]>>[number];
    try {
      entity = await client.getEntity(source.identifier);
    } catch (error) {
      if (!source.access_hash) throw error;
      entity = await client.getEntity(new Api.InputPeerChannel({
        channelId: bigInt(source.peer_id),accessHash: bigInt(source.access_hash),
      }));
    }
    let channel = entity as {className?:string;id?:{toString():string};username?:string};
    if (channel.id?.toString() !== source.peer_id) {
      if (!source.access_hash) throw new Error("TG_SOURCE_IDENTITY_MISMATCH: channel no longer matches");
      entity = await client.getEntity(new Api.InputPeerChannel({
        channelId:bigInt(source.peer_id),accessHash:bigInt(source.access_hash),
      }));
      channel = entity as typeof channel;
    }
    if (channel.className !== "Channel" || channel.id?.toString() !== source.peer_id || !channel.username)
      throw new Error("TG_SOURCE_UNSUPPORTED: only verified public channels can be rehydrated");

    const pending = await pool.query<{message_id:string}>(`
      SELECT message_id::text FROM tg_messages
      WHERE source_id=$1 AND deleted_at IS NULL AND entities_observed_at IS NULL
        AND (entities_refetch_attempted_at IS NULL OR entities_refetch_attempted_at<now()-interval '1 hour')
      ORDER BY message_id DESC LIMIT $2`,[source.id,limit]);
    let hydrated = 0;
    let unavailable = 0;
    for (let i=0;i<pending.rows.length;i+=25) {
      const selected = pending.rows.slice(i,i+25).map(row=>Number(row.message_id));
      const received = await client.getMessages(entity, {ids:selected}) as unknown as RawTelegramMessage[];
      const fetched = new Map(received.filter(row=>Number.isSafeInteger(row?.id) && row.id>0
        && typeof row.message==="string").map(row=>[row.id,row]));
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const days:string[]=[];
        for (const id of selected) {
          const row = fetched.get(id);
          // A missing post may be deleted or no longer publicly accessible. Do not invent entities.
          if (!row) { unavailable++; continue; }
          const lockRow = await tx.query<{posted_at:Date|null}>(`
            SELECT posted_at FROM tg_messages
            WHERE source_id=$1 AND message_id=$2 AND deleted_at IS NULL FOR UPDATE`,[source.id,id]);
          if (!lockRow.rowCount) continue;
          await persistMessage(tx, source.id, row);
          const oldDay = utcDay(lockRow.rows[0].posted_at);
          const newDay = typeof row.date === "number" ? utcDay(new Date(row.date*1000)) : null;
          if (oldDay) days.push(oldDay);
          if (newDay) days.push(newDay);
          hydrated++;
        }
        await refreshGraphDays(tx,source.id,days);
        await tx.query(`UPDATE tg_messages SET entities_refetch_attempted_at=now()
          WHERE source_id=$1 AND message_id=ANY($2::bigint[]) AND deleted_at IS NULL`,[source.id,selected]);
        await tx.query("COMMIT");
      } catch (error) {await tx.query("ROLLBACK");throw error;} finally {tx.release();}
    }
    const outstanding = await pool.query<{count:string}>(`
      SELECT count(*)::text AS count FROM tg_messages
      WHERE source_id=$1 AND deleted_at IS NULL AND entities_observed_at IS NULL`,[source.id]);
    console.log(JSON.stringify({source:handle,processed:pending.rows.length,hydrated,unavailable,
      stillMissing:outstanding.rows[0].count,
      note:"Unavailable posts remain unverified; this does not bypass Telegram access limits."},null,2));
  } finally {
    if (client) await client.disconnect().catch(()=>{});
    try { await guard.query("SELECT pg_advisory_unlock(8260226)"); }
    finally {guard.release();await pool.end();}
  }
}

main().catch(error=> {
  console.error("Entity refetch failed:",error instanceof Error?error.message:String(error));
  process.exitCode=1;
});
