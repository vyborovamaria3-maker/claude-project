import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {checkDestination} from "../scripts/etl-connections.mjs";

test("delivery readiness fails closed when token-link migration 004 is missing",async()=>{
  const calls=[];
  const query=async sql=>{
    calls.push(sql);
    return {rows:[{inbox:true,registry:true,evidence:true,timeline:true,token_links:false,inbox_fingerprint:true}]};
  };
  await assert.rejects(checkDestination({query}),/001\+002\+004/);
  assert.match(calls[0],/token_link_observations/);
  await assert.doesNotReject(checkDestination({query:async()=>({rows:[{
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,inbox_fingerprint:true,
  }]})}));
  await assert.rejects(checkDestination({query:async()=>({rows:[{
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,inbox_fingerprint:true,
    blockchain_revisions:false,
  }]})},{requireBlockchainRevisions:true}),/migration 005/);
  await assert.rejects(checkDestination({query:async()=>({rows:[{
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,inbox_fingerprint:false,
  }]})}),/migration 017/);
});
test("temporary PostgreSQL target requires additive 004, 005 and 017 before source claims",{
  skip:!process.env.INTELLIGENCE_TEST_DB_URL,
},async()=>{
  const url=process.env.INTELLIGENCE_TEST_DB_URL;
  const schema="gate_"+randomBytes(5).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const name of ["001_entity_registry.sql","002_timeline.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:2});
    await assert.rejects(checkDestination(pool),/001\+002\+004/);
    await admin.query(await readFile(new URL(
      "../migrations/004_token_link_observations.sql",import.meta.url),"utf8"));
    await assert.rejects(checkDestination(pool),/migration 017/);
    await admin.query(await readFile(new URL(
      "../migrations/017_inbox_payload_fingerprint.sql",import.meta.url),"utf8"));
    await assert.doesNotReject(checkDestination(pool));
    await assert.rejects(checkDestination(pool,{requireBlockchainRevisions:true}),/migration 005/);
    await admin.query(await readFile(new URL(
      "../migrations/005_blockchain_swap_evidence_revisions.sql",import.meta.url),"utf8"));
    await admin.query("INSERT INTO intelligence_inbox(source_system,event_kind,event_key,schema_version,evidence_source_id) VALUES('x','tweet_observed','snapshot-1','x-unattributed-snapshot-v1','x:tweet:1')");
    await assert.doesNotReject(checkDestination(pool,{requireBlockchainRevisions:true}),
      "destination-only unattributed snapshots are not source-outbox fingerprint backfill candidates");
    await admin.query("INSERT INTO intelligence_inbox(source_system,event_kind,event_key,schema_version,evidence_source_id) VALUES('tg','message_observed','legacy-1','tg-message-v1','tg:message:1')");
    await assert.rejects(checkDestination(pool),/legacy Intelligence inbox fingerprints pending/);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
