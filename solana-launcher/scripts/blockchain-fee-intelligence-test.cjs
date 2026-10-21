"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const { gzipSync }=require("node:zlib");
const { createHash }=require("node:crypto");
const Database=require("better-sqlite3");
const fee=require("./blockchain-fee-intelligence.cjs");
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
  } finally {
    output.close();source.close();fs.rmSync(dir,{recursive:true,force:true});
  }
  console.log("[blockchain-fee-intelligence] OK: exact fees, no double-count, candidate labels, failed tx, RAW bounds, read-only baseline");
}
run();
