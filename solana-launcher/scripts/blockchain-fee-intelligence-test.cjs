"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const { gzipSync }=require("node:zlib");
const { createHash }=require("node:crypto");
const Database=require("better-sqlite3");
const fee=require("./blockchain-fee-intelligence.cjs");
const rollup=require("./blockchain-fee-rollup.cjs");
const {inspectNativeBalances}=require("./blockchain-fee-balance-check.cjs");
const baseline=require("./blockchain-collector-baseline.cjs");
const SYSTEM="11111111111111111111111111111111";
function mkTx(signature,{failed=false,withTransfers=true,feeLamports=11000}={}) {
  const ins=withTransfers ? [
    {programId:SYSTEM,parsed:{type:"transfer",info:{source:"walletA",destination:"tip-account",lamports:30000}}},
    {programId:SYSTEM,parsed:{type:"transfer",info:{source:"walletA",destination:"service-account",lamports:"50000"}}},
    {programId:SYSTEM,parsed:{type:"transfer",info:{source:"walletA",destination:"random-account",lamports:2000}}},
    {programId:SYSTEM,parsed:{type:"createAccount",info:{source:"walletA",newAccount:"rent-account",lamports:2039280}}}
  ] : [];
  return {signature,slot:123,blockTime:1700000000,raw:{
    transaction:{signatures:[signature],message:{accountKeys:[{pubkey:"walletA",signer:true}],instructions:ins}},
    meta:{err:failed?{InstructionError:[0,"Custom"]}:null,fee:feeLamports,innerInstructions:[]}
  }};
}
function fixtureRow(db,kind,address,tx) {
  const serial=JSON.stringify(tx),bytes=Buffer.from(serial);
  db.prepare("INSERT INTO chain_seed_events(kind,address,signature,raw_revision,payload_hash,payload_gzip,payload_bytes,slot,block_time,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(kind,address,tx.signature,1,createHash("sha256").update(bytes).digest("hex"),gzipSync(bytes),bytes.length,123,1700000000,1700000000500);
}
function run() {
  assert.equal(fee.atomic("90071992547409930001").toString(),"90071992547409930001");
  assert.equal(fee.atomic(9007199254740993),null);
  assert.equal(fee.atomic(-1),null);
  assert.equal(fee.atomic("0.01"),null);
  const registry=fee.feeRegistry({jito_tip_accounts:["tip-account"],services:[{id:"terminal-A",recipient:"service-account",from_slot:1}]});
  const events=fee.extractFees(mkTx("sig-1"),registry);
  assert.deepEqual(events.map(e=>e.kind),["network_total","jito_tip_candidate","service_fee_candidate"]);
  assert.deepEqual(events.map(e=>e.amountAtomic),["11000","30000","50000"]);
  assert.equal(events[0].classificationReason.includes("base and priority"),true);
  assert.equal(events[1].status,"CANDIDATE");assert.equal(events[2].status,"CANDIDATE");
  assert.equal(events[0].payer,"walletA");
  assert.equal(fee.extractFees(mkTx("failed",{failed:true}),registry).length,1,
    "Failed tx still pays network fee but does not settle service or tip transfers");
  assert.equal(fee.extractFees(mkTx("unregistered"),fee.feeRegistry()).length,1);
  const overlapping=fee.feeRegistry({jito_tip_accounts:["tip-account"],
    services:[{id:"misleading-tip-service",recipient:"tip-account"},{id:"terminal-A",recipient:"service-account"}]});
  assert.equal(fee.extractFees(mkTx("overlap"),overlapping).length,2,
    "Conflicting recipient attribution must not produce a tip or service fee");
  assert.equal(rollup.reconcile([{payer:null,slot:1,amount_atomic:"12"}],["payer","slot"]).status,"PARTIAL");
  assert.deepEqual(inspectNativeBalances({fee:11000,preBalances:[100000,200000],postBalances:[90000,199000]}),
    {status:"MATCH",reason:"balance_sum_matches_reported_fee",deltaLamports:"-11000"});
  assert.equal(inspectNativeBalances({fee:11000,preBalances:[10000],postBalances:[10000]}).status,"MISMATCH");
  assert.equal(inspectNativeBalances({fee:11000,preBalances:[9007199254740993],postBalances:[0]}).status,"UNAVAILABLE");
  assert.equal(inspectNativeBalances({fee:11000,preBalances:[],postBalances:[]}).status,"UNAVAILABLE");
  assert.equal(inspectNativeBalances({fee:"90071992547409930001",
    preBalances:["90071992547409930002"],postBalances:["1"]}).status,"MATCH");


  assert.throws(()=>fee.extractFees({...mkTx("sig-1"),raw:{...mkTx("sig-1").raw,meta:null}}));
  assert.throws(()=>fee.extractFees({...mkTx("sig-1"),raw:{...mkTx("sig-1").raw,transaction:{...mkTx("sig-1").raw.transaction,signatures:["wrong"]}}}));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"fee-intelligence-"));
  const source=new Database(path.join(dir,"source.db")),output=new Database(path.join(dir,"out.db"));
  try {
    source.exec("CREATE TABLE chain_seed_events (kind TEXT,address TEXT,signature TEXT,raw_revision INTEGER,payload_hash TEXT,payload_gzip BLOB,payload_bytes INTEGER,slot INTEGER,block_time INTEGER,observed_at INTEGER)");
    fixtureRow(source,"wallet","walletA",mkTx("sig-1"));
    fixtureRow(source,"token","mint1",mkTx("sig-1"));
    fixtureRow(source,"wallet","walletA",mkTx("sig-2",{failed:true}));
    const record=mkTx("bad");
    fixtureRow(source,"wallet","walletA",record);
    source.prepare("UPDATE chain_seed_events SET payload_hash=? WHERE signature='bad'").run("0".repeat(64));
    const report=fee.project(source,output,{registry,limit:10});
    assert.equal(report.observations,4);
    assert.equal(report.invalidEvidence,1);
    assert.equal(report.networkFeeObservations,3);
    assert.equal(report.exportedEvents,7,"two success observations with 3 fees each, one failed tx fee");
    assert.equal(report.rollup.networkSignatures,2,"one transaction fee even if observed for wallet + mint");
    assert.equal(report.rollup.networkConsistent,2);
    assert.equal(report.rollup.candidateTransferGroups,2,"one tip + one service candidate per instruction");
    assert.equal(report.rollup.candidateConsistent,2);
    assert.deepEqual(output.prepare("SELECT signature,observation_count,status FROM fee_network_consensus ORDER BY signature")
      .all(),[{signature:"sig-1",observation_count:2,status:"OBSERVED_CONSISTENT"},
      {signature:"sig-2",observation_count:1,status:"OBSERVED_CONSISTENT"}]);
    assert.deepEqual(output.prepare("SELECT payer,unique_signatures,network_fee_lamports FROM fee_payer_observed_totals").all(),
      [{payer:"walletA",unique_signatures:2,network_fee_lamports:"22000"}]);
    assert.equal(output.prepare("SELECT COUNT(*) n FROM fee_transfer_consensus").get().n,2);
    assert.equal(output.prepare("SELECT COUNT(*) n FROM fee_transfer_consensus WHERE status='CANDIDATE_CONSISTENT'").get().n,2);
    assert.equal(rollup.decimal("90071992547409930001").toString(),"90071992547409930001");
    assert.throws(()=>rollup.decimal("9007199254740993.1"));

    assert.equal(output.prepare("SELECT count(*) n FROM fee_evidence").get().n,7);
    assert.equal(output.prepare("SELECT count(*) n FROM fee_evidence WHERE fee_kind='network_total'").get().n,3);
    assert.equal(output.prepare("SELECT count(*) n FROM fee_evidence WHERE fee_kind='service_fee_candidate' AND classification_status='CANDIDATE'").get().n,2);
    assert.equal(output.prepare("SELECT count(*) n FROM fee_evidence WHERE fee_kind='jito_tip_candidate'").get().n,2);
    assert.equal(output.prepare("SELECT count(*) n FROM fee_evidence WHERE fee_kind='network_base' OR fee_kind='priority_fee'").get().n,0);
    const audit=baseline.analyze(source,{sampleLimit:10});
    assert.equal(audit.diagnosticOnly,true);
    assert.equal(audit.evidence.stored_observations,4);
    assert.equal(audit.evidence.unique_signatures,3);
    assert.equal(audit.evidence.sample.corrupt,1);
    assert.equal(audit.evidence.sample.failedExecution,1);
    assert.equal(audit.coverage,null,"Missing coverage table must not become a fake zero");
    assert.equal(audit.evidence.sample.reportedNetworkFeeLamports,"33000");
    assert.equal(audit.evidence.sample.ingestDelayP50Ms,500);
    assert.equal(audit.evidence.sample.ingestDelayP95Ms,500);
    assert.throws(()=>baseline.analyze(source,{sampleLimit:1001}));
    // Different RAW receipts for the same signature MUST NOT be summed or silently selected.
    fixtureRow(source,"dex_program","program-A",mkTx("sig-1",{feeLamports:12000}));
    fixtureRow(source,"wallet","walletA",mkTx("sig-large",{feeLamports:"90071992547409930001",withTransfers:false}));
    fixtureRow(source,"token","mint-corrupt",mkTx("sig-2"));
    source.prepare("UPDATE chain_seed_events SET payload_hash=? WHERE kind='token' AND address='mint-corrupt'").run("f".repeat(64));
    const conflictingOutput=new Database(path.join(dir,"conflicting.db"));
    try {
      const conflicting=fee.project(source,conflictingOutput,{registry,limit:10});
      assert.equal(conflicting.rollup.networkSignatures,3);
      assert.equal(conflicting.rollup.networkConflicts,1);
      assert.equal(conflicting.rollup.networkWithheld,1,"A corrupt second copy blocks an otherwise usable signature");
      assert.equal(conflictingOutput.prepare("SELECT status FROM fee_network_consensus WHERE signature='sig-2'").get().status,"WITHHELD");
      assert.equal(conflictingOutput.prepare("SELECT count(*) n FROM fee_invalid_observations WHERE signature='sig-2'").get().n,1);
      const bad=conflictingOutput.prepare("SELECT status,reason,network_fee_lamports FROM fee_network_consensus WHERE signature='sig-1'").get();
      assert.equal(bad.status,"CONFLICT");assert.equal(bad.network_fee_lamports,null);
      const kept=conflictingOutput.prepare("SELECT unique_signatures,network_fee_lamports FROM fee_payer_observed_totals WHERE payer='walletA'").get();
      assert.equal(kept.unique_signatures,1);
      assert.equal(kept.network_fee_lamports,"90071992547409930001");
      const candidates=conflictingOutput.prepare("SELECT COUNT(*) n FROM fee_transfer_consensus WHERE signature='sig-1'").get().n;
      assert.equal(candidates,2,"Transfer candidates are kept separate from contradicted network totals");
    } finally { conflictingOutput.close(); }

    // An omitted service-fee candidate in one RAW observation stays PARTIAL.
    fixtureRow(source,"wallet","walletA",mkTx("sig-half"));
    fixtureRow(source,"token","mint-half",mkTx("sig-half",{withTransfers:false}));
    const mismatch=mkTx("sig-balance",{withTransfers:false});
    mismatch.raw.meta.preBalances=[100000];mismatch.raw.meta.postBalances=[100000];
    fixtureRow(source,"wallet","walletA",mismatch);
    const matching=mkTx("sig-balanced",{withTransfers:false});
    matching.raw.meta.preBalances=[100000];matching.raw.meta.postBalances=[89000];
    fixtureRow(source,"wallet","walletA",matching);
    const review=new Database(path.join(dir,"review.db"));
    try {
      const summary=fee.project(source,review,{registry,limit:20});
      assert.equal(summary.balanceChecks.MISMATCH,1);
      assert.equal(summary.balanceChecks.MATCH,1);
      assert.equal(review.prepare("SELECT status FROM fee_network_consensus WHERE signature='sig-balance'").get().status,
        "WITHHELD","Conservation mismatch cannot become a cost claim");
      assert.equal(review.prepare("SELECT status FROM fee_network_consensus WHERE signature='sig-balanced'").get().status,
        "OBSERVED_CONSISTENT");
      assert.equal(review.prepare("SELECT status FROM fee_network_consensus WHERE signature='sig-half'").get().status,
        "OBSERVED_CONSISTENT");
      const candidates=review.prepare("SELECT status,reason FROM fee_transfer_consensus WHERE signature='sig-half' ORDER BY event_key").all();
      assert.equal(candidates.length,2);
      assert.ok(candidates.every(x=>x.status==="PARTIAL" && x.reason==="candidate_missing_from_some_raw_observations"));
      assert.equal(review.prepare("SELECT count(*) n FROM fee_payer_observed_totals WHERE payer='walletA'").get().n,1);
    } finally { review.close(); }

  } finally {
    output.close();source.close();fs.rmSync(dir,{recursive:true,force:true});
  }
  console.log("[blockchain-fee-intelligence] OK: exact fees, no double-count, candidate labels, failed tx, RAW bounds, read-only baseline");
}
run();
