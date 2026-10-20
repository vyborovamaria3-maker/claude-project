import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import pg from "pg";
import Database from "better-sqlite3";
import {
  SQLITE_OUTBOX_DDL,emitSqlite,claimSqlite,ackSqlite,failSqlite,
} from "@claude-project/event-outbox";
import {runDeliveryBatch,queryTokenTimeline} from "../dist/index.js";

const require=createRequire(import.meta.url);
const {buildTokenSwapEvidenceEvent}=require(
  "../../solana-launcher/scripts/blockchain-token-swap-outbox.cjs");
const url=process.env.INTELLIGENCE_TEST_DB_URL;
const wallet="1".repeat(32);
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const signature="1".repeat(64);
const occurred="2026-10-18T01:00:00.000Z";
const observed="2026-10-20T01:00:00.000Z";
const timestamp=Date.parse(occurred)/1000;
const raw={
  signature,slot:320000001,timestamp,type:"SWAP",feePayer:wallet,fee:5000,
  events:{swap:{
    nativeInput:{account:wallet,amount:"1000000000"},
    tokenOutputs:[{userAccount:wallet,mint,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}],
  }},
  accountData:[{account:wallet,nativeBalanceChange:-1000005000,
    tokenBalanceChanges:[{userAccount:wallet,mint,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}],
};
const event=buildTokenSwapEvidenceEvent({
  kind:"wallet",address:wallet,signature,payloadHash:"c".repeat(64),
  observedAt:Date.parse(observed),transaction:raw,
});
assert.ok(event,"synthetic provider wallet swap should be recognized");

test("actual Blockchain swap Outbox -> Intelligence PG token timeline: as-of, provenance and replay",{
  skip:!url,
},async()=>{
  const schema="chain_mint_"+randomBytes(6).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;
  let sqlite;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const file of [
      "001_entity_registry.sql","002_timeline.sql",
      "004_token_link_observations.sql",
    ]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({
      connectionString:url,options:"-c search_path="+schema,max:3,
    });
    sqlite=new Database(":memory:");
    sqlite.exec(SQLITE_OUTBOX_DDL);
    sqlite.transaction(()=>emitSqlite(sqlite,event))();
    const source={
      claim:options=>claimSqlite(sqlite,options),
      ack:row=>ackSqlite(sqlite,row.id,row.leaseOwner,row.leaseUntil),
      fail:(row,code,next)=>failSqlite(sqlite,row.id,row.leaseOwner,row.leaseUntil,code,next),
    };
    const batch=()=>runDeliveryBatch(source,pool,{
      workerId:"chain-mint-test",batchSize:1,leaseMs:120_000,
    });
    assert.deepEqual(await batch(),{
      claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0,
    });
    const found=await queryTokenTimeline(pool,"solana:"+mint,
      "2026-10-18T02:00:00Z","2026-10-20T02:00:00Z");
    assert.equal(found.length,1);
    assert.equal(found[0].source_system,"blockchain");
    assert.equal(found[0].timeline_kind,"chain_transaction");
    assert.equal(found[0].evidence_source_id,"chain:tx:solana:"+signature);
    assert.deepEqual(found[0].payload,{
      attribution:"provider_parsed_wallet_swap",
      evidenceStatus:"historical_raw_revision_only",decoderVersion:"5",
    });
    assert.equal((await queryTokenTimeline(pool,"solana:"+mint,
      "2026-10-18T02:00:00Z","2026-10-19T02:00:00Z")).length,0,
      "late observation must not leak into historical analysis");
    assert.equal((await queryTokenTimeline(pool,"solana:"+mint,
      "2026-10-17T02:00:00Z","2026-10-20T02:00:00Z")).length,0,
      "time before swap occurred must not contain it");
    assert.equal((await queryTokenTimeline(pool,"solana:"+"So11111111111111111111111111111111111111112",
      "2026-10-18T02:00:00Z","2026-10-20T02:00:00Z")).length,0,
      "unrelated mint must not inherit swap");
    sqlite.prepare("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL").run();
    assert.deepEqual(await batch(),{
      claimed:1,delivered:0,duplicates:1,failed:0,lostLeases:0,
    });
    const count=await pool.query("SELECT COUNT(*)::integer AS n FROM timeline_events");
    assert.equal(count.rows[0].n,1);
    const joined=await pool.query(
      "SELECT kind,canonical_id FROM timeline_event_entities ORDER BY kind,canonical_id");
    assert.deepEqual(joined.rows.map(x=>x.kind),["token","wallet"]);
  }finally{
    if(sqlite)sqlite.close();
    if(pool)await pool.end();
    try{await admin.query("SET search_path TO public");await admin.query(
      'DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}
    finally{await admin.end()}
  }
});
