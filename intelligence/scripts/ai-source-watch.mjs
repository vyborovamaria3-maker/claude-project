import {createHash} from "node:crypto";
import {buildTgSnapshotEvent} from "./backfill-core.mjs";
import {ingestRegistryEvent,ingestTimelineEvent} from "../dist/index.js";

const observed="GREATEST(m.collected_at,(to_jsonb(m)->>'edited_at')::timestamptz)";
/** Start at the current high water; then atomically commit each page and its cursor. */
export async function importNewTelegramSnapshots(source,destination,limit=2){
 if(!Number.isSafeInteger(limit)||limit<1||limit>8)throw new TypeError("invalid_ai_watch_limit");
 const identityRow=(await source.query("SELECT current_database() AS db,current_schema() AS schema,current_user AS role,inet_server_addr()::text AS host,inet_server_port() AS port")).rows[0];
 if(!identityRow)throw new Error("ai_watch_source_identity_unavailable");
 const identity=createHash('sha256').update(JSON.stringify(identityRow)).digest('hex');
 const tx=await destination.connect();
 try{
  await tx.query('BEGIN');
  const ready=(await tx.query("SELECT to_regclass('ai_source_watch_cursors') IS NOT NULL AS ready")).rows[0]?.ready;
  if(!ready)throw new Error('ai_watch_migration_015_required');
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['ai-watch-tg|'+identity]);
  const existing=(await tx.query("SELECT observed_at::text AS at,source_id::text,message_id::text FROM ai_source_watch_cursors WHERE source_identity=$1 FOR UPDATE",[identity])).rows[0];
  if(!existing){
   const high=(await source.query(`SELECT ${observed}::text AS at,m.source_id::text,m.message_id::text FROM tg_messages m WHERE ${observed}<=clock_timestamp() ORDER BY ${observed} DESC,m.source_id DESC,m.message_id DESC LIMIT 1`)).rows[0];
   await tx.query("INSERT INTO ai_source_watch_cursors(source_identity,observed_at,source_id,message_id) VALUES($1,$2,$3,$4)",[identity,high?.at??'1970-01-01T00:00:00Z',high?.source_id??'0',high?.message_id??'0']);
   await tx.query('COMMIT');return {initialized:true,visited:0,imported:0,excluded:0};
  }
  const rows=(await source.query(`SELECT m.message_id,m.source_id,s.peer_id,${observed} AS collected_at,${observed}::text AS cursor_at,m.posted_at,m.deleted_at,m.text
   FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id
   WHERE (${observed},m.source_id,m.message_id)>($1::timestamptz,$2::bigint,$3::bigint)
     AND ${observed}<=clock_timestamp()
   ORDER BY ${observed},m.source_id,m.message_id LIMIT $4`,[existing.at,existing.source_id,existing.message_id,limit])).rows;
  const stats={initialized:false,visited:rows.length,imported:0,excluded:0};
  for(const row of rows){
   const event=buildTgSnapshotEvent(row);
   if(!event||typeof row.text!=="string"||!row.text.trim()){stats.excluded++;continue;}
   await ingestRegistryEvent(tx,event.payload.registryEvent);
   await ingestTimelineEvent(tx,'tg',event.eventKind,event.payload.timelineEvent);stats.imported++;
  }
  if(rows.length){const last=rows.at(-1);await tx.query("UPDATE ai_source_watch_cursors SET observed_at=$2,source_id=$3,message_id=$4,updated_at=clock_timestamp() WHERE source_identity=$1",[identity,last.cursor_at,last.source_id,last.message_id]);}
  await tx.query('COMMIT');return stats;
 }catch(error){try{await tx.query('ROLLBACK');}catch{}throw error;}
 finally{tx.release();}
}
