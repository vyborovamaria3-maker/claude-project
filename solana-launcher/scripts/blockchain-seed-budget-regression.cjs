#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const collector=require("./blockchain-seed-collector.cjs");

const SEED="5XaxQZGNEAPvF34iYHuTgfLBzpRGg1spPYeGSzr5pump";
const TOKEN_B="So11111111111111111111111111111111111111112";
const WALLET="11111111111111111111111111111111";
function dbFixture(){const db=new Database(":memory:");collector.initDb(db);return db;}
function args(runBudgetCredits,monthlyBudgetCredits,pageCreditEstimate=110){
 return {runBudgetCredits,monthlyBudgetCredits,pageCreditEstimate,limit:10,maxObjects:10};
}
(async()=>{
 const db=dbFixture();
 try {
  const scopeId=collector.ensurePilotScope(db,SEED);
  // A high-priority Excel row outside this scope must never be claimed by pilot.
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority,next_run_at) VALUES('token',?,4,9999,0)").run("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  collector.addScopeMember(db,scopeId,"token",TOKEN_B,900,"same_creator_token","creator","CreatorFixture");
  collector.addScopeMember(db,scopeId,"wallet",WALLET,800,"early_buyer","token",SEED);
  let claimed=collector.claimOne(db,true,scopeId);
  assert.equal(claimed.address,SEED,"seed token is first in its pilot scope");
  db.prepare("UPDATE chain_seed_targets SET lease_until=NULL,lease_token=NULL,next_run_at=? WHERE kind='token' AND address=?")
    .run(Date.now()+60000,SEED);
  claimed=collector.claimOne(db,true,scopeId);
  assert.equal(claimed.address,TOKEN_B,"highest-priority due member follows the seed");
  db.prepare("UPDATE chain_seed_targets SET lease_until=NULL,lease_token=NULL,next_run_at=0 WHERE kind=? AND address=?")
    .run(claimed.kind,claimed.address);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_members WHERE scope_id=?").get(scopeId).n,3);

  // Budget reservations are serialized and count estimates until a provider
  // reports actual credits. This models two concurrent workers sharing SQLite.
  const run1=collector.startCollectionRun(db,args(300,300),scopeId);
  const request1=collector.reserveHeliusCredits(db,{runId:run1,taskKind:"token",taskAddress:SEED,
    endpoint:"enhanced-address-transactions",estimatedCredits:110});
  collector.recordHeliusResponse(db,request1,{status:200,actualCredits:150});
  const request2=collector.reserveHeliusCredits(db,{runId:run1,taskKind:"wallet",taskAddress:WALLET,
    endpoint:"enhanced-address-transactions",estimatedCredits:110});
  collector.recordHeliusResponse(db,request2,{status:200,actualCredits:null});
  assert.throws(()=>collector.reserveHeliusCredits(db,{runId:run1,taskKind:"wallet",taskAddress:WALLET,
    endpoint:"enhanced-address-transactions",estimatedCredits:110}),e=>e.code==="HELIUS_BUDGET_EXCEEDED" && /Run Helius/.test(e.message));
  collector.finishCollectionRun(db,run1,"completed");
  const run2=collector.startCollectionRun(db,args(500,300),scopeId);
  assert.throws(()=>collector.reserveHeliusCredits(db,{runId:run2,taskKind:"token",taskAddress:SEED,
    endpoint:"enhanced-address-transactions",estimatedCredits:110}),e=>e.code==="HELIUS_BUDGET_EXCEEDED" && /Monthly Helius/.test(e.message));
  collector.finishCollectionRun(db,run2,"budget_paused","monthly budget reached");
  const usage=collector.usageStatus(db,{monthlyBudgetCredits:300});
  assert.equal(usage.usedCredits,260);
  assert.equal(usage.remainingCredits,40);
  assert.equal(usage.requests,2);
  assert.equal(usage.providerReportedRequests,1);

  // Budget-paused pagination must commit the page already paid for and resume
  // from its cursor without creating duplicate raw transactions.
  db.prepare("UPDATE chain_seed_targets SET next_run_at=0,lease_until=NULL,lease_token=NULL WHERE kind='token' AND address=?").run(SEED);
  let row=collector.claimOne(db,true,scopeId);
  const tx1={signature:"paid-page-signature",slot:200,timestamp:1700000200,type:"UNKNOWN"};
  const first=await collector.processOne(db,row,{recentLimit:200,backfillLimit:200,scopeId},{
    fetchEnrichedTxsForMintWithMeta:async()=>({transactions:[tx1],exhausted:false,truncated:true,
      reachedKnownHistory:false,budgetExhausted:true})
  });
  assert.equal(first.budgetPaused,true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='token' AND address=?").get(SEED).n,1);
  assert.equal(db.prepare("SELECT backfill_cursor FROM chain_seed_targets WHERE kind='token' AND address=?").get(SEED).backfill_cursor,tx1.signature);
  row=collector.claimOne(db,true,scopeId);
  assert.equal(row.address,SEED,"paused task is immediately resumable");
  const tx0={signature:"older-signature",slot:199,timestamp:1700000199,type:"UNKNOWN"};
  let calls=0;
  const resumed=await collector.processOne(db,row,{recentLimit:200,backfillLimit:200,scopeId},{
    fetchEnrichedTxsForMintWithMeta:async(address,limit,known,cursor,includeTokenAccounts)=>{
      calls++;
      if(calls===1){assert(known.has(tx1.signature));return {transactions:[tx1],exhausted:false,truncated:false,reachedKnownHistory:true};}
      assert.equal(cursor,tx1.signature);
      return {transactions:[tx0],exhausted:true,truncated:false,reachedKnownHistory:false};
    }
  });
  assert.equal(resumed.complete,true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='token' AND address=?").get(SEED).n,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='token' AND address=? AND signature=?").get(SEED,tx1.signature).n,1);

  // Token trade participant discovery is scoped and idempotent.
  const trade={signature:"swap-fixture",events:{swap:{tokenOutputs:[{
    mint:SEED,userAccount:WALLET,rawTokenAmount:{tokenAmount:"1",decimals:0}
  }]}}};
  assert.equal(collector.appendDiscoveredWallets(db,"token",SEED,[trade],scopeId),1);
  assert.equal(collector.appendDiscoveredWallets(db,"token",SEED,[trade],scopeId),1,
    "discovery return count reflects observed candidates, membership remains idempotent");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_members WHERE scope_id=? AND kind='wallet' AND address=?").get(scopeId,WALLET).n,1);
 } finally {db.close();}

 const capped=dbFixture();
 try {
  const scopeId=collector.ensurePilotScope(capped,SEED);
  const run=collector.startCollectionRun(capped,args(100,1000),scopeId);
  assert.throws(()=>collector.reserveHeliusCredits(capped,{runId:run,taskKind:"token",taskAddress:SEED,
    endpoint:"enhanced-address-transactions",estimatedCredits:110}),e=>e.code==="HELIUS_BUDGET_EXCEEDED" && /Run Helius/.test(e.message));
  collector.finishCollectionRun(capped,run,"budget_paused","run budget reached");
 } finally {capped.close();}
 console.log("[blockchain-seed-budget-regression] OK: seed-only scope, queue priority, monthly/run guards, estimated vs reported usage, partial-page checkpoint and resume");
})().catch(error=>{console.error(error);process.exitCode=1;});
