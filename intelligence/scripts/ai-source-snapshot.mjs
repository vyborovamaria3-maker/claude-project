import {buildXSnapshotEvent,buildTgSnapshotEvent} from "./backfill-core.mjs";
import {ingestRegistryEvent,ingestTimelineEvent,isLowValueTelegramPost} from "../dist/index.js";

async function writeUnattributedXSnapshot(tx,row){
  if(!/^[1-9][0-9]{0,24}$/.test(row.tweet_id))throw new TypeError("invalid_snapshot_tweet");
  const ms=Number(row.updated_at);
  if(!Number.isSafeInteger(ms)||ms<0||ms>Date.now())throw new TypeError("invalid_snapshot_timestamp");
  const observedAt=new Date(ms).toISOString();
  const published=row.posted_at===null?ms:Number(row.posted_at);
  if(!Number.isSafeInteger(published)||published<0||published>ms)throw new TypeError("invalid_snapshot_publication");
  const occurredAt=new Date(published).toISOString();
  const key=`x:ai:tweet:${row.tweet_id}:snapshot:${ms}`,ref=`x:tweet:${row.tweet_id}`;
  // The legacy collector has handles but no stable user IDs. Keep authors/tokens unknown.
  // This explicit source snapshot is not an unverified registry/outbox envelope.
  const inbox=await tx.query(`INSERT INTO intelligence_inbox(source_system,event_kind,event_key,schema_version,evidence_source_id)
    VALUES('x','tweet_observed',$1,'x-unattributed-snapshot-v1',$2)
    ON CONFLICT(source_system,event_kind,event_key) DO UPDATE SET event_key=EXCLUDED.event_key
    WHERE intelligence_inbox.schema_version=EXCLUDED.schema_version AND intelligence_inbox.evidence_source_id=EXCLUDED.evidence_source_id
    RETURNING event_key`,[key,ref]);
  if(inbox.rows.length!==1)throw new Error("snapshot_identity_conflict");
  const timeline=await tx.query(`INSERT INTO timeline_events
    (source_system,source_event_kind,event_key,timeline_kind,occurred_at,observed_at,evidence_source_id,schema_version,payload)
    VALUES('x','tweet_observed',$1,'tweet_published',$2,$3,$4,'timeline-v1','{}')
    ON CONFLICT(source_system,source_event_kind,event_key) DO UPDATE SET event_key=EXCLUDED.event_key
    WHERE timeline_events.timeline_kind=EXCLUDED.timeline_kind AND timeline_events.occurred_at=EXCLUDED.occurred_at
      AND timeline_events.observed_at=EXCLUDED.observed_at AND timeline_events.evidence_source_id=EXCLUDED.evidence_source_id
      AND timeline_events.schema_version=EXCLUDED.schema_version AND timeline_events.payload=EXCLUDED.payload
    RETURNING event_key`,[key,occurredAt,observedAt,ref]);
  if(timeline.rows.length!==1)throw new Error("snapshot_identity_conflict");
}

/** Legacy collectors can feed AI without installing/mutating their source outbox. */
export async function importAiSourceSnapshots(sourcePool,destination,source,limit=2){
  if(!["x","tg"].includes(source)||!Number.isSafeInteger(limit)||limit<1||limit>8)throw new TypeError("invalid_ai_snapshot_options");
  const reader=await sourcePool.connect();
  let rows;
  try{
    await reader.query("BEGIN READ ONLY");
    if(source==="x"){
      const columns=await reader.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='twitter_tweets'");
      const hasAuthor=columns.rows.some(r=>r.column_name==="author_id");
      const archive=hasAuthor?"":"LEFT JOIN archive_posts a ON a.id=t.tweet_id";
      rows=(await reader.query(`SELECT t.tweet_id,${hasAuthor?"t.author_id":"a.author_id"} AS author_id,t.updated_at,t.posted_at
        FROM twitter_tweets t ${archive} WHERE t.text IS NOT NULL AND btrim(t.text)<>''
        ORDER BY t.updated_at DESC,t.tweet_id DESC LIMIT $1`,[limit])).rows;
    }else rows=(await reader.query(`SELECT m.message_id,s.peer_id,m.collected_at,m.posted_at,m.deleted_at,m.text
      FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id
      WHERE m.deleted_at IS NULL AND m.text IS NOT NULL AND btrim(m.text)<>''
      ORDER BY m.collected_at DESC,m.message_id DESC LIMIT $1`,[Math.max(32,limit*16)])).rows;
    await reader.query("COMMIT");
  }catch(error){try{await reader.query("ROLLBACK");}catch{}throw error;}
  finally{reader.release();}
  const stats={visited:rows.length,imported:0,excluded:0,unattributed:0};
  for(const row of rows){
    if(stats.imported>=limit)break;
    if(source==="tg"&&isLowValueTelegramPost(row.text)){stats.excluded++;continue;}
    const event=source==="x"?buildXSnapshotEvent(row):buildTgSnapshotEvent(row);
    if(!event&&source!=="x"){stats.excluded++;continue;}
    const tx=await destination.connect();
    try{
      await tx.query("BEGIN");
      if(event){
        await ingestRegistryEvent(tx,event.payload.registryEvent);
        await ingestTimelineEvent(tx,source,event.eventKind,event.payload.timelineEvent);
      }else{await writeUnattributedXSnapshot(tx,row);stats.unattributed++;}
      await tx.query("COMMIT");stats.imported++;
    }catch(error){try{await tx.query("ROLLBACK");}catch{}throw error;}
    finally{tx.release();}
  }
  return stats;
}
