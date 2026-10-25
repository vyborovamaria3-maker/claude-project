import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {refreshTokenDailyCrossPlatform} from "../dist/index.js";
import {formatTokenId} from "@claude-project/contracts";

const dbUrl=process.env.INTELLIGENCE_TEST_DB_URL;
const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
const migrations=["001_entity_registry.sql","002_timeline.sql","003_feature_store.sql",
"004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql",
"006_cross_platform_analytics.sql","008_alert_status_history.sql","009_ai_analysis.sql",
"010_intelligence_governance.sql"];

test("deleted Telegram evidence is excluded as-of without erasing history",{skip:!dbUrl},async()=>{
 const db=new pg.Client({connectionString:dbUrl});
 await db.connect();
 try{
  await db.query("BEGIN");
  const schema="deletion_"+randomBytes(6).toString("hex");
  await db.query('CREATE SCHEMA "'+schema+'"');
  await db.query('SET LOCAL search_path TO "'+schema+'"');
  for(const migration of migrations)
    await db.query(await readFile(new URL("../migrations/"+migration,import.meta.url),"utf8"));
  await db.query(`INSERT INTO entity_registry(kind,canonical_id,first_seen_at,last_seen_at)
     VALUES('token',$1,'2026-10-20T12:00Z','2026-10-20T12:00Z')`,[token]);
  await db.query(`INSERT INTO intelligence_inbox
    (source_system,event_kind,event_key,schema_version,evidence_source_id,ingested_at)
    VALUES('tg','message_observed','message-1','test','tg:message:123:1','2026-10-20T12:05Z')`);
  await db.query(`INSERT INTO timeline_events
    (source_system,source_event_kind,event_key,timeline_kind,occurred_at,observed_at,
     evidence_source_id,schema_version,payload)
    VALUES('tg','message_observed','message-1','tg_message_published','2026-10-20T12:00Z',
     '2026-10-20T12:04Z','tg:message:123:1','test','{}')`);
  await db.query(`INSERT INTO timeline_event_entities
     (source_system,source_event_kind,event_key,kind,canonical_id)
     VALUES('tg','message_observed','message-1','token',$1)`,[token]);
  await db.query(`INSERT INTO source_coverage_windows
    (source_system,scope,window_start,window_end,known_at,status,evidence_count,
     details,details_sha256,created_at)
    VALUES('tg','timeline_events','2026-10-20T00:00Z','2026-10-21T00:00Z',
     '2026-10-21T01:00Z','partial',1,'{}',$1,'2026-10-21T01:00Z')`,["0".repeat(64)]);
  const before=await refreshTokenDailyCrossPlatform(db,token,"2026-10-20","2026-10-21T12:00:00Z");
  assert.equal(before.tgMentions,1);
  await db.query(`INSERT INTO intelligence_inbox
    (source_system,event_kind,event_key,schema_version,evidence_source_id,ingested_at)
    VALUES('tg','message_deleted','message-1-deleted','test','tg:message:123:1',
      '2026-10-22T00:00Z')`);
  const after=await refreshTokenDailyCrossPlatform(db,token,"2026-10-20","2026-10-22T12:00:00Z");
  assert.equal(after.tgMentions,null);
  assert.equal(after.firstMentionTgAt,null);
  assert.ok(Date.parse(after.maxInputObservedAt)>=Date.parse("2026-10-22T00:00:00Z"),
    "a delivered deletion must advance input provenance");
  const historic=await db.query(`SELECT tg_mentions FROM token_daily_cross_platform
    WHERE canonical_token_id=$1 AND as_of='2026-10-21T12:00Z'`,[token]);
  assert.equal(Number(historic.rows[0].tg_mentions),1);
  await db.query("ROLLBACK");
 }catch(error){try{await db.query("ROLLBACK")}catch{}throw error}
 finally{await db.end()}
});