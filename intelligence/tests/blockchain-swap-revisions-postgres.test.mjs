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
import {
  runDeliveryBatch,queryActiveBlockchainSwapEvidence,ingestBlockchainSwapRevision,
} from "../dist/index.js";

const require=createRequire(import.meta.url);
const {buildTokenSwapRevisionEvent}=require(
  "../../solana-launcher/scripts/blockchain-token-swap-revisions.cjs");
const url=process.env.INTELLIGENCE_TEST_DB_URL;
const wallet="1".repeat(32);
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const signature="1".repeat(64);
const txTime=Date.parse("2026-10-18T01:00:00Z")/1000;
const mint2=(()=>{
  // Deterministic, structurally valid synthetic 32-byte address (no RPC).
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value=BigInt("0x"+("42".repeat(32))),result="";
  while(value>0n){result=alphabet[Number(value%58n)]+result;value/=58n;}
  return result;
})();
const transaction=(token,slot)=>({
  signature,slot,timestamp:txTime,type:"SWAP",feePayer:wallet,fee:5000,
  events:{swap:{
    nativeInput:{account:wallet,amount:"1000000000"},
    tokenOutputs:[{userAccount:wallet,mint:token,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}],
  }},
  accountData:[{account:wallet,nativeBalanceChange:-1000005000,
    tokenBalanceChanges:[{userAccount:wallet,mint:token,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}],
});
const makeRevision=(rawRevision,hash,observedAt,transaction)=>buildTokenSwapRevisionEvent({
  kind:"wallet",address:wallet,signature,rawRevision,
  payloadHash:hash.repeat(64),observedAt:Date.parse(observedAt),transaction,
});
const r1=makeRevision(1,"a","2026-10-20T01:00:00Z",transaction(mint,320000001));
const r2=makeRevision(2,"b","2026-10-20T01:10:00Z",
  {...transaction(mint,320000002),type:"UNKNOWN"});
const r3=makeRevision(3,"c","2026-10-20T01:20:00Z",transaction(mint2,320000003));
assert.equal(r1.payload.swapRevision.status,"supported");
assert.equal(r2.payload.swapRevision.status,"unsupported");
assert.equal(r3.payload.swapRevision.status,"supported");
assert.equal(r3.payload.swapRevision.canonicalTokenId,"solana:"+mint2);

test("ARCH-06b: immutable PG revisions, unsupported correction, late delivery, as-of and token dedup",{
  skip:!url,
},async()=>{
  const schema="chain_rev_"+randomBytes(6).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool,sqlite;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const file of ["001_entity_registry.sql","002_timeline.sql",
      "005_blockchain_swap_evidence_revisions.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    sqlite=new Database(":memory:");
    sqlite.exec(SQLITE_OUTBOX_DDL);
    const source={
      claim:options=>claimSqlite(sqlite,options),
      ack:row=>ackSqlite(sqlite,row.id,row.leaseOwner,row.leaseUntil),
      fail:(row,code,next)=>failSqlite(sqlite,row.id,row.leaseOwner,row.leaseUntil,code,next),
    };
    const deliver=()=>runDeliveryBatch(source,pool,{
      workerId:"chain-revision-test",batchSize:1,leaseMs:120000,
    });
    const active=(token,knownAt,occurredBefore="2026-10-18T02:00:00Z")=>
      queryActiveBlockchainSwapEvidence(pool,"solana:"+token,occurredBefore,knownAt);
    // Newest raw revision is delivered first to simulate source/retry reordering.
    emitSqlite(sqlite,r3);
    emitSqlite(sqlite,r1);
    emitSqlite(sqlite,r2);
    for(let i=0;i<3;i++)
      assert.deepEqual(await deliver(),{
        claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0,
      });
    assert.equal((await active(mint,"2026-10-20T01:05:00Z")).length,1,
      "before correction, original proof was genuinely known");
    assert.equal((await active(mint,"2026-10-20T01:15:00Z")).length,0,
      "unsupported revision supersedes the old token association");
    assert.equal((await active(mint,"2026-10-20T01:30:00Z")).length,0,
      "corrected mint must not leave a stale claim on the old token");
    const current=await active(mint2,"2026-10-20T01:30:00Z");
    assert.equal(current.length,1);
    assert.equal(current[0].raw_revision,"3");
    assert.equal(current[0].signature,signature);
    assert.equal((await active(mint2,"2026-10-20T01:15:00Z")).length,0,
      "future raw revision must not leak into an older knownAt");
    assert.equal((await active(mint2,"2026-10-20T01:30:00Z",
      "2026-10-17T02:00:00Z")).length,0,
      "event occurrence must also respect as-of cutoff");
    const history=await pool.query(
      "SELECT state,raw_revision,canonical_token_id FROM blockchain_swap_evidence_revisions ORDER BY raw_revision");
    assert.equal(history.rows.length,3,"unsupported revisions remain auditable");
    assert.deepEqual(history.rows.map(r=>r.state),["supported","unsupported","supported"]);
    // ACK loss/replay returns a duplicate, not a fresh revision or timeline.
    sqlite.prepare("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL").run();
    for(let i=0;i<3;i++)
      assert.deepEqual(await deliver(),{
        claimed:1,delivered:0,duplicates:1,failed:0,lostLeases:0,
      });
    const count=await pool.query("SELECT COUNT(*)::integer AS n FROM blockchain_swap_evidence_revisions");
    assert.equal(count.rows[0].n,3);
    // Reused event identity with altered proof is rejected, never silently ACKed.
    const corrupted=structuredClone(r1);
    corrupted.payload.swapRevision.rawSha256="f".repeat(64);
    await assert.rejects(
      ingestBlockchainSwapRevision(pool,{
        sourceSystem:corrupted.sourceSystem,eventKind:corrupted.eventKind,
        eventKey:corrupted.eventKey,schemaVersion:corrupted.schemaVersion,
        payload:corrupted.payload,
      }),
      /key mismatch/,
    );
    // A second wallet can observe the same signature + token; token-level
    // active projection must count it once, without inventing trade PnL.
    let bytes=BigInt("0x"+("43".repeat(32))),wallet2="";
    const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    while(bytes>0n){wallet2=alphabet[Number(bytes%58n)]+wallet2;bytes/=58n;}
    const tx2=transaction(mint2,320000003);
    tx2.feePayer=wallet2;
    tx2.events.swap.nativeInput.account=wallet2;
    tx2.events.swap.tokenOutputs[0].userAccount=wallet2;
    tx2.accountData[0].account=wallet2;
    tx2.accountData[0].tokenBalanceChanges[0].userAccount=wallet2;
    const fromOtherWallet=buildTokenSwapRevisionEvent({
      kind:"wallet",address:wallet2,signature,rawRevision:1,
      payloadHash:"d".repeat(64),observedAt:Date.parse("2026-10-20T01:21:00Z"),
      transaction:tx2,
    });
    assert.equal(fromOtherWallet.payload.swapRevision.status,"supported");
    emitSqlite(sqlite,fromOtherWallet);
    assert.deepEqual(await deliver(),{
      claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0,
    });
    assert.equal((await active(mint2,"2026-10-20T01:30:00Z")).length,1,
      "same signature and mint observed from two wallets is one token-level record");
    const afterSecond=await pool.query(
      "SELECT COUNT(*)::integer AS n FROM blockchain_swap_evidence_revisions");
    assert.equal(afterSecond.rows[0].n,4);
  }finally{
    if(sqlite)sqlite.close();
    if(pool)await pool.end();
    try{await admin.query("SET search_path TO public");await admin.query(
      'DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}
    finally{await admin.end()}
  }
});
