#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {initDb, appendDiscovered, processOne} = require("./blockchain-seed-collector.cjs");
const {isSolanaAddress} = require("./blockchain-seed-core.cjs");
const BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const wallet="1".repeat(32);
const db = new Database(":memory:");
(async()=>{
 try {
  initDb(db);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('wallet',?,4,90)").run(wallet);
  const txs=Array.from({length:31},(_,i)=>{
    const mint="1".repeat(31)+BASE58[i+1];
    assert.equal(isSolanaAddress(mint),true);
    return {signature:"swap-"+String(i),slot:100+i,timestamp:1000+i,type:"SWAP",
      feePayer:wallet,fee:5000,
      events:{swap:{nativeInput:{account:wallet,amount:"1000000000"},
        tokenOutputs:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}},
      accountData:[{account:wallet,nativeBalanceChange:-1000005000,
        tokenBalanceChanges:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}]};
  });
  let calls=0;
  const api={fetchEnrichedTxsForMintWithMeta:async(address,limit,known,cursor,tokens)=>{
    calls++;
    assert.equal(address,wallet);
    assert.equal(tokens,true,"wallet scan must include token accounts");
    if(calls===1) return {transactions:txs,exhausted:true,truncated:false,reachedKnownHistory:false};
    assert(known.size>0);
    return {transactions:[],exhausted:false,truncated:false,reachedKnownHistory:true};
  }};
  let row=db.prepare("SELECT * FROM chain_seed_targets WHERE kind='wallet' AND address=?").get(wallet);
  let result=await processOne(db,row,{recentLimit:200,backfillLimit:200},api);
  assert.equal(result.newEvents,31);
  assert.equal(result.complete,true);
  assert.equal(result.normalizedTrades,0,"mint scans must not pollute legacy trade tape");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_file_sources WHERE category='discovered'").get().n,31,
    "no arbitrary 25-token discovery limit");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_processed_signatures").get().n,31);
  assert.equal(appendDiscovered(db,wallet,txs),0,"already stored discovered mints remain deduplicated");
  row=db.prepare("SELECT * FROM chain_seed_targets WHERE kind='wallet' AND address=?").get(wallet);
  result=await processOne(db,row,{recentLimit:200,backfillLimit:200},api);
  assert.equal(result.newEvents,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='wallet'").get().n,31);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_activities").get().n,31);
  console.log("[blockchain-collector-forensics-integration] OK: 31 discovered mints, durable raw cache, no stale repeats, wallet token-account coverage");
 } finally {db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
