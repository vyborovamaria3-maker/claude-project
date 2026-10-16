#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const collector=require("./blockchain-seed-collector.cjs");
const {PUMP_FUN_PROGRAM_ID,extractPumpFunLaunches}=require("./blockchain-pumpfun-discovery.cjs");

const SEED="5XaxQZGNEAPvF34iYHuTgfLBzpRGg1spPYeGSzr5pump";
const CREATOR="11111111111111111111111111111112";
const OTHER_CREATOR="Vote111111111111111111111111111111111111111";
const TOKEN_B="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_C="So11111111111111111111111111111111111111112";
const WALLET="11111111111111111111111111111113";
const RELAYER="SysvarRent111111111111111111111111111111111";
const create=(mint,creator=CREATOR,signature="launch-"+mint)=>({
  signature,slot:100,timestamp:1700000000,source:"PUMP_FUN",type:"CREATE",feePayer:RELAYER,
  instructions:[{programId:PUMP_FUN_PROGRAM_ID,name:"create",accounts:[RELAYER,creator,mint]}],
});
function makeDb(){const db=new Database(":memory:");collector.initDb(db);return db;}

const parsed=collector.parseArgs(["--mode","pilot","--seed-token",SEED,"--monthly-credits-used","0"]);
assert.equal(parsed.mode,"pilot");
assert.equal(parsed.maxRuntimeMs,6*60*60*1000);
assert.equal(parsed.creatorWaveTokens,200);
assert.equal(parsed.tokenWaveWallets,5000);
assert.equal(parsed.walletWaveCreators,20);
assert.equal(parsed.maxObjects,10000);
assert.equal(collector.shouldStopForRuntime(1000,6000,6999),false);
assert.equal(collector.shouldStopForRuntime(1000,6000,7000),true);

const launches=extractPumpFunLaunches([
  create(SEED),
  create(SEED,CREATOR,"launch-duplicate"),
  {...create(TOKEN_B),source:"RAYDIUM"},
  {...create(TOKEN_C),transactionError:{InstructionError:[0,"failed"]}},
  {...create(TOKEN_C),instructions:[{programId:RELAYER,name:"create",accounts:[RELAYER,CREATOR,TOKEN_C]}]},
]);
assert.equal(launches.length,1,"only successful, explicit Pump.fun create instruction evidence is accepted and deduplicated by creator+mint");
assert.equal(launches.find(x=>x.mint===SEED).creator,CREATOR,"creator comes from create accounts, not fee payer");

const db=makeDb();
try{
  const scope=collector.ensurePilotScope(db,SEED);
  assert.equal(collector.ensurePilotScope(db,SEED),scope,"resuming the same pilot must reuse its scope");
  const run=collector.startCollectionRun(db,parsed,scope);
  assert.equal(db.prepare("SELECT max_runtime_ms FROM chain_collection_runs WHERE run_id=?").get(run).max_runtime_ms,6*60*60*1000);
  collector.finishCollectionRun(db,run,"completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_members WHERE scope_id=?").get(scope).n,1,
    "pilot starts with only the requested token");
  assert.equal(collector.appendDiscoveredCreators(db,scope,SEED,[create(SEED)]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_pumpfun_creator_launches WHERE scope_id=?").get(scope).n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_members WHERE scope_id=? AND kind='creator' AND address=?").get(scope,CREATOR).n,1);

  // Creator's discovered launch set is durable, but only one child is promoted
  // when the configured active-wave cap is one.
  collector.appendDiscoveredCreatorTokens(db,scope,CREATOR,[create(TOKEN_B),create(TOKEN_C,CREATOR,"launch-token-c")]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_deferred WHERE scope_id=? AND parent_kind='creator' AND kind='token'").get(scope).n,2);
  assert.equal(collector.promoteDeferredWaves(db,scope,{creatorWaveTokens:1}),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_members WHERE scope_id=? AND discovered_from_kind='creator' AND kind='token'").get(scope).n,1);
  assert.equal(collector.promoteDeferredWaves(db,scope,{creatorWaveTokens:1}),0,"must not exceed active creator wave cap");
  const activeCreatorToken=db.prepare("SELECT address FROM chain_collection_scope_members WHERE scope_id=? AND discovered_from_kind='creator' AND kind='token'").get(scope).address;
  db.prepare("UPDATE chain_seed_targets SET backfill_complete=1 WHERE kind='token' AND address=?").run(activeCreatorToken);
  assert.equal(collector.promoteDeferredWaves(db,scope,{creatorWaveTokens:1}),1,"deferred creator launches resume in the next wave");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_deferred WHERE scope_id=? AND parent_kind='creator' AND kind='token'").get(scope).n,0);

  // A token can discover many wallet participants, but only the configured
  // number of incomplete wallets is activated at once; all others remain queued.
  const transfer={signature:"transfer-participants",tokenTransfers:[{
    mint:SEED,fromUserAccount:CREATOR,toUserAccount:WALLET
  }]};
  collector.appendDiscoveredWallets(db,"token",SEED,[transfer],scope);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_deferred WHERE scope_id=? AND parent_kind='token' AND kind='wallet'").get(scope).n,2);
  assert.equal(collector.promoteDeferredWaves(db,scope,{tokenWaveWallets:1}),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_members WHERE scope_id=? AND discovered_from_kind='token' AND kind='wallet'").get(scope).n,1);
  assert.equal(collector.promoteDeferredWaves(db,scope,{tokenWaveWallets:1}),0);

  // A wallet can defer creator candidates; these are deduplicated and promoted
  // according to the wallet-specific cap.
  collector.deferScopeMember(db,scope,"wallet",WALLET,"creator",CREATOR,750,"creator-from-wallet","wallet",WALLET);
  collector.deferScopeMember(db,scope,"wallet",WALLET,"creator",OTHER_CREATOR,740,"creator-from-wallet","wallet",WALLET);
  assert.equal(collector.promoteDeferredWaves(db,scope,{walletWaveCreators:1}),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_wave_members WHERE scope_id=? AND parent_kind='wallet' AND parent_address=? AND kind='creator'").get(scope,WALLET).n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_collection_scope_deferred WHERE scope_id=? AND parent_kind='wallet' AND kind='creator'").get(scope).n,1);
  const creatorNextRun=Date.now()+24*60*60*1000;
  db.prepare("UPDATE chain_seed_targets SET backfill_complete=1,last_success_at=?,next_run_at=? WHERE kind='creator' AND address=?")
    .run(Date.now(),creatorNextRun,CREATOR);
  collector.appendDiscoveredCreators(db,scope,SEED,[create(SEED)]);
  assert.equal(db.prepare("SELECT next_run_at FROM chain_seed_targets WHERE kind='creator' AND address=?").get(CREATOR).next_run_at,creatorNextRun,
    "rediscovering a completed creator must not force a costly full-history reparse");
  const status=collector.status(db,{monthlyCreditsUsedBaseline:0,monthlyCreditsBaselineConfigured:true});
  assert.equal(status.pumpfunCreatorLaunches,3);
  assert(status.deferred.some(x=>x.kind==="creator"&&x.count===1));
}finally{db.close();}
console.log("[blockchain-recursive-pilot-regression] OK: only seed token, evidence-gated Pump.fun creator, resumable launch registry, bounded token/wallet/creator waves and runtime limit");
