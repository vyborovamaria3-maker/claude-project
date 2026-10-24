#!/usr/bin/env node
import pg from "pg";
import {sourceConnection} from "./etl-connections.mjs";
import {parseSnapshotEncryptionKey,readCollectorMessage,storeEncryptedEventText} from "../dist/index.js";
async function main(){
  if(process.env.INTELLIGENCE_TEXT_SNAPSHOT_IMPORT_ENABLED!=="true")
    throw new Error("text_snapshot_explicit_opt_in_required");
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=="--source"||args[2]!=="--limit"||!["x","tg"].includes(args[1]))
    throw new TypeError("invalid_text_snapshot_arguments");
  const limit=Number(args[3]),days=Number(process.env.INTELLIGENCE_TEXT_RETENTION_DAYS??"7");
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||
     !Number.isSafeInteger(days)||days<1||days>30)
    throw new TypeError("invalid_text_snapshot_bounds");
  const key=parseSnapshotEncryptionKey(process.env.INTELLIGENCE_TEXT_ENCRYPTION_KEY_B64);
  const keyRef=process.env.INTELLIGENCE_TEXT_KEY_REF;
  if(!keyRef||!/^[a-zA-Z0-9._:-]{1,128}$/.test(keyRef))
    throw new TypeError("text_snapshot_key_ref_required");
  const dsn=process.env.INTELLIGENCE_DATABASE_URL;
  if(!dsn)throw new Error("destination_database_config_required");
  const source=sourceConnection(args[1],false);
  const dest=new pg.Client({connectionString:dsn,connectionTimeoutMillis:4000,
    query_timeout:25000,statement_timeout:20000});
  try{
    await dest.connect();
    const ready=await dest.query("SELECT to_regclass('event_text_snapshots') IS NOT NULL AS ready");
    if(ready.rows[0]?.ready!==true)throw new Error("intelligence_migration_010_required");
    // Only recent delivered events; expired historic texts must never re-enter.
    const pending=await dest.query(`SELECT t.source_system,t.source_event_kind,t.event_key,
      t.evidence_source_id,t.observed_at FROM timeline_events t
      JOIN intelligence_inbox i ON i.source_system=t.source_system
        AND i.event_kind=t.source_event_kind AND i.event_key=t.event_key
      WHERE t.source_system=$1 AND t.timeline_kind IN ('tweet_published','tg_message_published')
        AND t.observed_at>=clock_timestamp()-($2::integer*INTERVAL '1 day')
        AND i.ingested_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM intelligence_inbox removed
          WHERE removed.source_system=i.source_system
            AND removed.evidence_source_id=i.evidence_source_id
            AND removed.event_kind IN ('message_deleted','token_links_invalidated')
            AND (removed.event_kind='message_deleted' OR removed.ingested_at>=i.ingested_at))
        AND NOT EXISTS(SELECT 1 FROM event_text_snapshots s
          WHERE s.source_system=t.source_system AND s.source_event_kind=t.source_event_kind
            AND s.event_key=t.event_key)
      ORDER BY t.observed_at DESC,t.event_key LIMIT $3`,[args[1],days,limit]);
    let stored=0,unavailable=0;
    for(const event of pending.rows){
      const text=await readCollectorMessage(source.connection,args[1],
        event.evidence_source_id,event.observed_at);
      if(text===null){unavailable++;continue}
      await dest.query("BEGIN");
      try{
        const inserted=await storeEncryptedEventText(dest,{sourceSystem:args[1],
          sourceEventKind:event.source_event_kind,eventKey:event.event_key,
          observedAt:event.observed_at,text,key,keyRef,retentionDays:days});
        await dest.query("COMMIT");if(inserted)stored++;else unavailable++;
      }catch(e){await dest.query("ROLLBACK");throw e}
    }
    process.stdout.write(JSON.stringify({source:args[1],requested:pending.rows.length,stored,unavailable})+"\n");
  }finally{await dest.end();await source.close();key.fill(0)}
}
main().catch(error=>{
  process.stderr.write(error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)
    ?error.message+"\n":"text_snapshot_import_failed\n");
  process.exitCode=1;
});
