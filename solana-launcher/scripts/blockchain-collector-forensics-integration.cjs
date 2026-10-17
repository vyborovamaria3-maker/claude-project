#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {initDb, appendDiscovered, processOne, persistEvents, claimOne} = require("./blockchain-seed-collector.cjs");
const {isSolanaAddress} = require("./blockchain-seed-core.cjs");
const {rebuildWallet} = require("./blockchain-forensics.cjs");
const BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const wallet="1".repeat(32);
const db = new Database(":memory:");
(async()=>{
 try {
  initDb(db);
  // Provider-specific request logs feed one idempotent ledger without mixing CU and credits.
  db.prepare("INSERT INTO chain_collection_runs(run_id,started_at,run_budget_credits,monthly_budget_credits,page_credit_estimate,max_objects) VALUES('run-ledger',1,1000,1000,100,1)").run();
  db.prepare("INSERT INTO chain_helius_usage_requests(request_id,run_id,month_key,task_kind,task_address,endpoint,estimated_credits,status,created_at) VALUES('h-ledger','run-ledger','2026-10','wallet',?,'history',110,'reserved',2)").run(wallet);
  assert.equal(db.prepare("SELECT provider,cost_kind,estimated_units FROM chain_budget_ledger WHERE request_id='h-ledger'").get().provider,"helius");
  db.prepare("UPDATE chain_helius_usage_requests SET actual_credits=95,status='completed',http_status=200,finished_at=3 WHERE request_id='h-ledger'").run();
  assert.equal(db.prepare("SELECT actual_units,status FROM chain_budget_ledger WHERE request_id='h-ledger'").get().actual_units,95);
  db.prepare("INSERT INTO chain_alchemy_usage_requests(request_id,run_id,scope_id,account_id,month_key,task_kind,task_address,method,estimated_cu,status,created_at) VALUES('a-ledger','run-ledger',NULL,'alchemy-1','2026-10','wallet',?,'getTransactionsForAddress',100,'reserved',4)").run(wallet);
  const alchemyLedger=db.prepare("SELECT provider,cost_kind,estimated_units FROM chain_budget_ledger WHERE request_id='a-ledger'").get();
  assert.equal(alchemyLedger.provider,"alchemy");
  assert.equal(alchemyLedger.cost_kind,"cu");
  assert.equal(alchemyLedger.estimated_units,100);
  initDb(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_budget_ledger").get().n,2,
    "reinitialization must not duplicate or repeatedly backfill ledger entries");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_schema_migrations WHERE migration_key='budget-ledger-backfill-v1'").get().n,1);
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
    if(calls===1) return {provider:"helius",transactions:txs,exhausted:true,truncated:false,reachedKnownHistory:false};
    assert(known.size>0);
    return {provider:"helius",transactions:[],exhausted:false,truncated:false,reachedKnownHistory:true};
  }};
  let row=db.prepare("SELECT * FROM chain_seed_targets WHERE kind='wallet' AND address=?").get(wallet);
  let result=await processOne(db,row,{recentLimit:200,backfillLimit:200},api);
  assert.equal(result.newEvents,31);
  assert.equal(result.complete,true);
  assert.equal(result.normalizedTrades,0,"mint scans must not pollute legacy trade tape");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_file_sources WHERE category='discovered'").get().n,31,
    "no arbitrary 25-token discovery limit");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_processed_signatures").get().n,31);
  assert.equal(db.prepare("SELECT DISTINCT decoder_version AS v FROM chain_forensic_processed_signatures").get().v,"5");
  assert.equal(db.prepare("SELECT decoder_version AS v FROM chain_forensic_wallet_sync WHERE wallet=?").get(wallet).v,"5");
  const coverage=db.prepare("SELECT coverage_status,source_provider,observed_transactions,oldest_slot,newest_slot FROM chain_history_coverage WHERE kind='wallet' AND address=?").get(wallet);
  assert.deepEqual(coverage,{coverage_status:"provider_exhausted",source_provider:"helius",observed_transactions:31,oldest_slot:100,newest_slot:130});
  // Decoder version mismatch must rebuild normalized analytics from SQLite raw payloads.
  db.prepare("UPDATE chain_forensic_wallet_sync SET decoder_version='old' WHERE wallet=?").run(wallet);
  const replay=rebuildWallet(db,wallet);
  assert.equal(replay.skipped,false);
  assert.equal(replay.newlyParsed,31);
  assert.equal(db.prepare("SELECT decoder_version FROM chain_forensic_wallet_sync WHERE wallet=?").get(wallet).decoder_version,"5");
  assert.equal(appendDiscovered(db,wallet,txs),0,"already stored discovered mints remain deduplicated");
  row=db.prepare("SELECT * FROM chain_seed_targets WHERE kind='wallet' AND address=?").get(wallet);
  result=await processOne(db,row,{recentLimit:200,backfillLimit:200},api);
  assert.equal(result.newEvents,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='wallet'").get().n,31);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_activities").get().n,31);
  // A same-signature re-decode is stored with a new raw revision, and a
  // retry with identical bytes is a no-op.
  const improved={...txs[0],slot:250,timestamp:2500};
  assert.equal(persistEvents(db,"wallet",wallet,[improved]),1);
  const revised=db.prepare("SELECT raw_revision,payload_hash FROM chain_seed_events WHERE kind='wallet' AND address=? AND signature=?").get(wallet,improved.signature);
  assert.equal(revised.raw_revision,2);
  assert.equal(typeof revised.payload_hash,"string");
  assert.equal(persistEvents(db,"wallet",wallet,[improved]),0);
  const invalidatedCoverage=db.prepare("SELECT coverage_status,gap_reason FROM chain_history_coverage WHERE kind='wallet' AND address=?").get(wallet);
  assert.equal(invalidatedCoverage.coverage_status,"partial","raw evidence revisions invalidate prior coverage");
  assert.equal(invalidatedCoverage.gap_reason,"raw_evidence_changed_requires_coverage_refresh");

  // A malformed payload that fails forensic indexing must roll back raw
  // evidence, wallet discovery and success cursors together.
  const failedWallet="2".repeat(44);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('wallet',?,4,110)").run(failedWallet);
  const malformed={signature:"malformed",type:"SWAP",slot:300,timestamp:3000,
    events:{swap:{tokenOutputs:{notAnArray:true}}}};
  const badApi={fetchEnrichedTxsForMintWithMeta:async()=>({
    transactions:[malformed],exhausted:true,truncated:false,reachedKnownHistory:false
  })};
  let failedTarget=db.prepare("SELECT * FROM chain_seed_targets WHERE address=?").get(failedWallet);
  await assert.rejects(processOne(db,failedTarget,{recentLimit:100,backfillLimit:100},badApi));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE address=?").get(failedWallet).n,0);
  assert.equal(db.prepare("SELECT last_success_at FROM chain_seed_targets WHERE address=?").get(failedWallet).last_success_at,null);

  // A lease takeover must fence old workers before any data is written.
  failedTarget=claimOne(db,false);
  assert.equal(failedTarget.address,failedWallet);
  assert.equal(typeof failedTarget.lease_token,"string");
  db.prepare("UPDATE chain_seed_targets SET lease_token='new-owner' WHERE kind='wallet' AND address=?").run(failedWallet);
  const cleanApi={fetchEnrichedTxsForMintWithMeta:async()=>({
    provider:"helius",transactions:[],exhausted:true,truncated:false,reachedKnownHistory:false
  })};
  await assert.rejects(processOne(db,failedTarget,{recentLimit:100,backfillLimit:100},cleanApi),/lease lost/);
  assert.equal(db.prepare("SELECT lease_token FROM chain_seed_targets WHERE address=?").get(failedWallet).lease_token,"new-owner");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE address=?").get(failedWallet).n,0);
  console.log("[blockchain-collector-forensics-integration] OK: 31 discovered mints, durable raw cache, no stale repeats, wallet token-account coverage");
 } finally {db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
