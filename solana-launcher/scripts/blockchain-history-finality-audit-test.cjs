"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const Database=require("better-sqlite3");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const {initDb,persistEvents}=require("./blockchain-seed-collector.cjs");
const {aggregate,main}=require("./blockchain-history-finality-audit.cjs");
const fixtures=require("./fixtures/alchemy-saved-swaps.json");
function saved(i){return normalizeFullTransaction(fixtures[i]);}
function target(db,kind,address,{coverage=true,gap=false,complete=true}={}){
  db.prepare("INSERT INTO chain_seed_targets(kind,address,backfill_complete,possible_gap,collection_provider,raw_history_seen) VALUES(?,?,?,?,?,0)")
    .run(kind,address,complete?1:0,gap?1:0,"alchemy");
  if(coverage)db.prepare([
    "INSERT INTO chain_forensic_history_coverage",
    "(kind,address,coverage_status,source_provider,observed_transactions,",
    "backfill_complete,possible_gap,forward_cursor_pending,updated_at)",
    "VALUES(?,?,?,?,?,?,?,?,?)"
  ].join(" ")).run(kind,address,complete&&!gap?"provider_exhausted":"partial","alchemy",1,
    complete?1:0,gap?1:0,0,Date.now());
}
function run(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"history-finality-"));
  const filepath=path.join(temp,"collector.db");
  const db=new Database(filepath);
  try{
    initDb(db);
    const first=saved(0);
    const address=first.accountKeys[0];
    assert.match(address,/^[1-9A-HJ-NP-Za-km-z]{20,60}$/);
    target(db,"wallet",address);
    target(db,"token","mint-good");
    persistEvents(db,"wallet",address,[first]);
    persistEvents(db,"token","mint-good",[first]);
    const second=saved(1);
    target(db,"wallet","wallet-revision");
    persistEvents(db,"wallet","wallet-revision",[second]);
    const changed=structuredClone(second);
    changed.raw.meta.fee+=1;
    persistEvents(db,"wallet","wallet-revision",[changed]);
    const third=saved(2);
    target(db,"wallet","wallet-diverge");
    target(db,"token","mint-diverge");
    persistEvents(db,"wallet","wallet-diverge",[third]);
    const divergent=structuredClone(third);divergent.raw.meta.fee+=1;
    persistEvents(db,"token","mint-diverge",[divergent]);
    const fourth=saved(3);
    target(db,"wallet","wallet-corrupt");
    persistEvents(db,"wallet","wallet-corrupt",[fourth]);
    db.prepare("UPDATE chain_seed_events SET payload_hash=? WHERE signature=?")
      .run("f".repeat(64),fourth.signature);
    const fifth=saved(4);
    fifth.raw.meta.err={InstructionError:[0,"Custom"]};
    fifth.transactionError={InstructionError:[0,"Custom"]};
    target(db,"wallet","wallet-failed");
    persistEvents(db,"wallet","wallet-failed",[fifth]);
    const sixth=saved(5);
    persistEvents(db,"wallet","wallet-missing-target",[sixth]);
    // In production processOne finalizes coverage flags after RAW ingestion
    // in the SAME commit. The fixture mimics that final checkpoint update.
    db.prepare("UPDATE chain_forensic_history_coverage SET coverage_status='provider_exhausted', possible_gap=0, backfill_complete=1, forward_cursor_pending=0, gap_reason=NULL WHERE address NOT IN ('wallet-corrupt')").run();
    const seventh=saved(6);
    target(db,"wallet","wallet-no-execution");
    delete seventh.raw.meta.err; // Offline raw cannot prove transaction success.
    persistEvents(db,"wallet","wallet-no-execution",[seventh]);
    const eighth=saved(7);
    target(db,"wallet","wallet-no-slot");
    eighth.slot=null;eighth.raw.slot=null;
    persistEvents(db,"wallet","wallet-no-slot",[eighth]);
    db.prepare("UPDATE chain_forensic_history_coverage SET coverage_status='provider_exhausted', possible_gap=0, backfill_complete=1, forward_cursor_pending=0 WHERE address IN ('wallet-no-execution','wallet-no-slot')").run();
    const report=aggregate(db,{limit:20});
    assert.equal(report.version,"history-finality-audit-v1");
    assert.equal(report.finalityVerified,false);
    assert.equal(report.pnlEligible,false);
    assert.equal(report.historyComplete,false);
    assert.equal(report.distinctSignaturesSampled,8);
    const bySig=new Map(report.signatures.map(s=>[s.signature,s]));
    assert.equal(bySig.get(first.signature).status,"PENDING_INDEPENDENT_FINALITY");
    assert.equal(bySig.get(first.signature).observationCopies,2);
    assert.equal(bySig.get(first.signature).validatedCopies,2);
    assert.equal(bySig.get(first.signature).flags.length,0,
      "Even a clean collector/coverage claim cannot assert finality");
    assert.equal(bySig.get(second.signature).status,"RECHECK_RAW_BEFORE_FINALITY");
    assert.ok(bySig.get(second.signature).flags.includes("RAW_REWRITE_OR_CORRECTION_OBSERVED"));
    assert.equal(bySig.get(third.signature).status,"RECHECK_RAW_BEFORE_FINALITY");
    assert.ok(bySig.get(third.signature).flags.includes("CROSS_TARGET_RAW_OR_SLOT_DISAGREEMENT"));
    assert.equal(bySig.get(fourth.signature).status,"RECHECK_RAW_BEFORE_FINALITY");
    assert.ok(bySig.get(fourth.signature).flags.includes("CURRENT_RAW_CORRUPT_OR_UNSUPPORTED"));
    assert.equal(bySig.get(fifth.signature).status,"NO_SUCCESSFUL_EXECUTION_EVIDENCE");
    assert.equal(bySig.get(sixth.signature).status,"INCOMPLETE_HISTORY_OR_REVISIONS");
    assert.ok(bySig.get(sixth.signature).flags.includes("COLLECTOR_TARGET_MISSING"));
    assert.ok(bySig.get(sixth.signature).flags.includes("FORENSIC_COVERAGE_MISSING"));
    assert.equal(bySig.get(seventh.signature).status,"NO_SUCCESSFUL_EXECUTION_EVIDENCE");
    assert.ok(bySig.get(seventh.signature).flags.includes("EXECUTION_STATUS_UNKNOWN"));
    assert.equal(bySig.get(eighth.signature).status,"INCOMPLETE_HISTORY_OR_REVISIONS");
    assert.ok(bySig.get(eighth.signature).flags.includes("SLOT_UNAVAILABLE_FOR_FINALITY"));
    const scoped=aggregate(db,{kind:"wallet",address,limit:5});
    assert.equal(scoped.sampleScope,"target");
    assert.equal(scoped.signatures.length,1);
    assert.equal(scoped.signatures[0].signature,first.signature);
    assert.throws(()=>aggregate(db,{kind:"wallet"}),/must be supplied together/);
    assert.throws(()=>aggregate(db,{signature:first.signature,kind:"wallet",address}),/cannot be combined/);
    const truncated=aggregate(db,{limit:1});
    assert.equal(truncated.distinctSignaturesSampled,1);
    assert.equal(truncated.sampleTruncated,true);
    assert.throws(()=>aggregate(db,{limit:201}),/limit must/);
    assert.throws(()=>aggregate(db,{signature:"not a solana signature!"}),/base58/);
    const focused=aggregate(db,{signature:first.signature});
    assert.equal(focused.signatures.length,1);
    assert.equal(focused.sampleTruncated,false);
    assert.equal(focused.signatures[0].status,"PENDING_INDEPENDENT_FINALITY");
    // A valid envelope checksum cannot hide disagreement with its nested RPC
    // receipt. These fresh single-revision sources previously passed all gates.
    for(const field of ["slot","blockTime","signature","missing_signature"]){
      const inconsistent=new Database(":memory:");
      try{
        initDb(inconsistent);
        target(inconsistent,"wallet",address);
        const tampered=structuredClone(first);
        if(field.endsWith("signature")){
          tampered.raw.signature=first.signature;
          if(field==="signature")tampered.raw.transaction.signatures[0]="2".repeat(88);
          else delete tampered.raw.transaction.signatures;
        }else tampered.raw[field]+=1;
        persistEvents(inconsistent,"wallet",address,[tampered]);
        inconsistent.prepare("UPDATE chain_forensic_history_coverage SET coverage_status='provider_exhausted',possible_gap=0,backfill_complete=1,forward_cursor_pending=0,gap_reason=NULL").run();
        const audited=aggregate(inconsistent,{signature:first.signature}).signatures[0];
        assert.equal(audited.status,"RECHECK_RAW_BEFORE_FINALITY",field);
        assert.ok(audited.flags.includes("CURRENT_RAW_CORRUPT_OR_UNSUPPORTED"),field);
        assert.throws(()=>require("./blockchain-finality-witness-store.cjs").sourceIdentity(
          inconsistent,"wallet",address,first.signature),/not eligible/,field);
      }finally{inconsistent.close();}
    }
    db.close();
    const bytes=fs.readFileSync(filepath);
    const cli=main(["--db",filepath,"--signature",first.signature]);
    assert.equal(cli.signatures[0].status,"PENDING_INDEPENDENT_FINALITY");
    const targeted=main(["--db",filepath,"--kind","wallet","--address",address,"--limit","5"]);
    assert.equal(targeted.signatures.length,1);
    assert.equal(targeted.signatures[0].signature,first.signature);
    assert.deepEqual(fs.readFileSync(filepath),bytes,"Read-only audit may not mutate stored RAW");
  }finally{if(db.open)db.close();fs.rmSync(temp,{recursive:true,force:true});}
  console.log("[blockchain-history-finality-audit] OK: 8 real retained Alchemy receipts, cross-target conflict, revisions, corruption, gap/finality gate, readonly");
}
run();
