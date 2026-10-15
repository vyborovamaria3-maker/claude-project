#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initDb, syncDexProgramSources, processOne, claimOne } = require("./blockchain-seed-collector.cjs");
const { extractDexObservations, indexProgramBatch, replayProgram, configuredDexPrograms } = require("./blockchain-dex-index.cjs");
const program="1".repeat(32);
const wallet="2".repeat(44);
const mint="3".repeat(44);
const db=new Database(":memory:");
(async()=>{
try {
  initDb(db);
  assert.deepEqual(configuredDexPrograms(program+","+program),[program]);
  assert.throws(()=>configuredDexPrograms("not-a-solana-address"),/valid 32-byte/);
  const source=syncDexProgramSources(db,program);
  assert.deepEqual(source.programs,[program]);
  assert.equal(source.changed,true);
  assert.equal(syncDexProgramSources(db,program).changed,false);
  const target=db.prepare("SELECT * FROM chain_seed_targets WHERE kind='dex_program' AND address=?").get(program);
  assert.equal(target.source_mask,16);
  assert.equal(target.priority,105);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('token',?,1,120)").run(mint);
  const claim=claimOne(db,false);
  assert.equal(claim.kind,"dex_program","opt-in DEX scanning ignores expensive mint-only history even if higher priority");

  const tx={signature:"dex-sig-1",slot:111500000,timestamp:1700000000,
    type:"SWAP",source:"RAYDIUM",feePayer:wallet,fee:5000,
    events:{swap:{nativeInput:{account:wallet,amount:"2000000000"},
      tokenOutputs:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"5000000",decimals:6}}]}},
    accountData:[{account:wallet,nativeBalanceChange:-2000005000,
      tokenBalanceChanges:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"5000000",decimals:6}}]}]};
  const observations=extractDexObservations(tx,program);
  assert.equal(observations.length,1);
  assert.equal(observations[0].wallet,wallet);
  assert.equal(observations[0].mint,mint);
  assert.equal(observations[0].side,"buy");
  const bad=JSON.parse(JSON.stringify(tx));
  bad.signature="wrong-balance";
  bad.accountData[0].tokenBalanceChanges[0].rawTokenAmount.tokenAmount="9000000";
  assert.equal(extractDexObservations(bad,program).length,0,"Unexplained balance movement cannot become observed trade");
  const unknown={...tx,signature:"opaque",events:{},accountData:undefined};
  assert.equal(extractDexObservations(unknown,program).length,0);
  const api={fetchEnrichedTxsForMintWithMeta:async(address,limit,known,cursor,tokenAccounts)=>{
    assert.equal(address,program);
    assert.equal(tokenAccounts,false,"DEX program scans must not expand to unrelated owner token accounts");
    assert.equal(cursor,undefined);
    return {transactions:[tx],exhausted:true,truncated:false,reachedKnownHistory:false};
  }};
  const result=await processOne(db,claim,{recentLimit:50,backfillLimit:50},api);
  assert.equal(result.newEvents,1);
  assert.equal(result.complete,true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_dex_observed_trades").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='dex_program'").get().n,1);
  assert.equal(indexProgramBatch(db,program,[tx]).observations,0,"No duplicate DEX evidence on replay");
  assert.equal(replayProgram(db,program,100).observations,0,"Raw transactions already indexed");
  const otherProgram="4".repeat(44);
  assert.equal(indexProgramBatch(db,otherProgram,[tx]).observations,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_dex_observed_trades").get().n,2,
    "Observations retain distinct program provenance for deduplication in API");
  syncDexProgramSources(db,"");
  assert.equal(db.prepare("SELECT source_mask FROM chain_seed_targets WHERE kind='dex_program' AND address=?").get(program).source_mask,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_dex_observed_trades").get().n,2,
    "Removing programs from queue must not delete persisted audit trail");
  console.log("[blockchain-dex-index-regression] OK: program opt-in, raw persistence, wallet attribution, conserved balance, dedup, replay, configured removal");
}finally{db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
