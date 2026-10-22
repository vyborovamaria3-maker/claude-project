"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const Database=require("better-sqlite3");
const {initDb,persistEvents}=require("./blockchain-seed-collector.cjs");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const fixture=require("./fixtures/alchemy-saved-swaps.json");
const {openState,watchOnce,runPaths,ensureSeparate,readScope}=require("./blockchain-finality-watch-state.cjs");
const {parse}=require("./blockchain-finality-watch.cjs");
const {review,main:reviewMain}=require("./blockchain-finality-watch-report.cjs");
function seed(db,kind,address,event){
  db.prepare("INSERT OR IGNORE INTO chain_seed_targets(kind,address,backfill_complete,possible_gap,collection_provider,raw_history_seen) VALUES(?,?,1,0,'alchemy',0)").run(kind,address);
  persistEvents(db,kind,address,[event]);
  db.prepare([
    "INSERT INTO chain_forensic_history_coverage",
    "(kind,address,coverage_status,source_provider,observed_transactions,backfill_complete,possible_gap,forward_cursor_pending,updated_at)",
    "VALUES(?,?,'provider_exhausted','alchemy',1,1,0,0,?)",
    "ON CONFLICT(kind,address) DO UPDATE SET coverage_status='provider_exhausted',backfill_complete=1,possible_gap=0,forward_cursor_pending=0,gap_reason=NULL"
  ].join(" ")).run(kind,address,Date.now());
}
function run(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"finality-watch-"));
  const sourcePath=path.join(dir,"collector.db"),statePath=path.join(dir,"watch-state.db");
  const source=new Database(sourcePath);
  let state;
  try{
    initDb(source);
    const a=normalizeFullTransaction(fixture[0]),b=normalizeFullTransaction(fixture[1]);
    const wallet=a.accountKeys[0];
    assert.match(wallet,/^[1-9A-HJ-NP-Za-km-z]{20,60}$/);
    seed(source,"wallet",wallet,a);
    seed(source,"token","mint-target",a);
    seed(source,"wallet",wallet,b);
    state=openState(statePath);
    assert.equal(state.pragma("application_id",{simple:true}),0x46495731);
    let tick=100;
    const now=()=>++tick;
    let summary=watchOnce(source,state,{kind:"wallet",address:wallet,limit:1,clock:now});
    assert.equal(summary.independentFinalityVerified,false);
    assert.equal(summary.pnlEligible,false);
    assert.equal(summary.scanned,1);
    assert.equal(summary.newObservations,1);
    assert.equal(summary.invalidationsQueued,0);
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_current").get().n,1);
    // Resume cursor and revisit oldest: bounded work survives crash/restart.
    summary=watchOnce(source,state,{kind:"wallet",address:wallet,limit:1,clock:now});
    assert.equal(summary.scanned,1);
    assert.equal(summary.reviewed,2);
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_current").get().n,2);
    const countBeforeBackwards=state.prepare("SELECT count(*) n FROM watcher_observations").get().n;
    assert.throws(()=>watchOnce(source,state,{kind:"wallet",address:wallet,limit:1,clock:()=>1}),
      /Watch clock moved backwards/);
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_observations").get().n,
      countBeforeBackwards,"Rejected clock rollback must leave the journal unchanged");
    const scopeName="wallet:"+wallet;
    const cursorBeforeFailure=state.prepare("SELECT scan_cursor,next_sequence,last_run_at FROM watcher_scopes WHERE scope=?").get(scopeName);
    const failCommitSource={
      prepare:(...args)=>source.prepare(...args),
      exec:sql=>{
        if(sql==="COMMIT")throw Error("synthetic source snapshot close failure");
        return source.exec(sql);
      }
    };
    assert.throws(()=>watchOnce(failCommitSource,state,{kind:"wallet",address:wallet,limit:1,clock:now}),
      /synthetic source snapshot close failure/);
    assert.deepEqual(state.prepare("SELECT scan_cursor,next_sequence,last_run_at FROM watcher_scopes WHERE scope=?").get(scopeName),
      cursorBeforeFailure,"Source snapshot failure must roll back watcher cursor and sequence");
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_observations").get().n,
      countBeforeBackwards,"Source snapshot failure cannot leave committed evidence");
    state.close();state=null;
    const before=fs.readFileSync(sourcePath);
    const third=runPaths({db:sourcePath,state:statePath,kind:"wallet",address:wallet,limit:1},
      {clock:now});
    assert.equal(third.unchanged,1);
    assert.equal(third.invalidationsQueued,0);
    assert.deepEqual(fs.readFileSync(sourcePath),before,"Watcher must not change collector source");
    state=openState(statePath);
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_observations").get().n,2);
    const changed=structuredClone(a);
    changed.raw.meta.fee+=123;
    persistEvents(source,"wallet",wallet,[changed]);
    // Source RAW revision trigger correctly invalidates provider coverage.
    summary=watchOnce(source,state,{signature:a.signature,limit:1,clock:now});
    assert.equal(summary.scanned,1);
    assert.equal(summary.newObservations,1);
    assert.equal(summary.invalidationsQueued,1,
      "Scope creates distinct baseline and may be immediately disputed");
    summary=watchOnce(source,state,{kind:"wallet",address:wallet,limit:2,clock:now});
    assert.ok(summary.invalidationsQueued>=1);
    assert.ok(summary.states.disputed_evidence>=1);
    const outbox=state.prepare("SELECT * FROM watcher_invalidation_outbox ORDER BY id").all();
    assert.ok(outbox.some(x=>x.reason==="evidence_fingerprint_or_quality_changed"));
    assert.ok(outbox.every(x=>x.state==="pending"));
    const reviewList=review(state,{limit:1});
    assert.equal(reviewList.diagnosticOnly,true);
    assert.equal(reviewList.autoApplied,false);
    assert.equal(reviewList.shown,1);
    assert.equal(reviewList.totalPending,outbox.length);
    assert.equal(review(state,{limit:1,afterId:reviewList.nextAfterId}).shown,
      outbox.length>1?1:0);
    assert.throws(()=>review(state,{limit:1000}),/Invalid review pagination/);
    assert.equal(reviewMain(["--state",statePath,"--limit","1"]).shown,1);
    const count=outbox.length;
    summary=watchOnce(source,state,{kind:"wallet",address:wallet,limit:2,clock:now});
    assert.equal(summary.invalidationsQueued,0,"Identical RAW evidence must not enqueue duplicates");
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_invalidation_outbox").get().n,count);
    assert.throws(()=>state.prepare("DELETE FROM watcher_observations").run(),/immutable/);
    assert.throws(()=>state.prepare("UPDATE watcher_invalidation_outbox SET state='done'").run(),/manual review/);
    assert.throws(()=>ensureSeparate(sourcePath,sourcePath),/separate/);
    assert.throws(()=>openState(sourcePath),/schema|required|SQLite/);
    const tamperedPath=path.join(dir,"broken-watch.db");
    const fresh=openState(tamperedPath);fresh.close();
    const adversary=new Database(tamperedPath);
    adversary.exec("DROP TRIGGER watcher_observation_immutable_update");
    adversary.close();
    assert.throws(()=>openState(tamperedPath),/immutable journal trigger missing/,
      "Journal trigger removal must prevent opening a mutable state DB");
    const tornPath=path.join(dir,"torn-watch.db");
    const complete=openState(tornPath);complete.close();
    const invalid=new Database(tornPath);
    invalid.exec("DROP TABLE watcher_current");
    invalid.close();
    assert.throws(()=>openState(tornPath),/Watcher state table missing/,
      "A file with a valid app-id but missing tables cannot silently resume");
    assert.throws(()=>readScope({kind:"wallet"}),/scope/);
    assert.throws(()=>parse(["--db",sourcePath,"--state",statePath,"--watch","--interval-seconds","1"]),/60 and 3600/);
    assert.throws(()=>watchOnce(source,state,{limit:101}),/1..100/);
    // Signatures deleted from source are not silently treated as still present.
    source.prepare("DELETE FROM chain_seed_events WHERE signature=?").run(b.signature);
    let sawMissing=false;
    for(let i=0;i<4;i++){
      const step=watchOnce(source,state,{kind:"wallet",address:wallet,limit:2,clock:now});
      if(step.states.history_incomplete){sawMissing=true;break;}
    }
    assert.equal(sawMissing,true,"Previously monitored signatures must be rechecked even when deleted");
    assert.ok(state.prepare("SELECT count(*) n FROM watcher_invalidation_outbox WHERE signature=?").get(b.signature).n>=1);
    assert.equal(state.prepare("SELECT state FROM watcher_current WHERE scope=? AND signature=?")
      .get("wallet:"+wallet,b.signature).state,"history_incomplete");
    // A local coverage metadata change with the SAME overall dispute status
    // must still change the fingerprint and request manual invalidation.
    const prevCoverageFingerprint=state.prepare(
      "SELECT raw_fingerprint FROM watcher_current WHERE scope=? AND signature=?"
    ).get("wallet:"+wallet,a.signature).raw_fingerprint;
    source.prepare("UPDATE chain_forensic_history_coverage SET observed_transactions=observed_transactions+1 WHERE kind='wallet' AND address=?").run(wallet);
    const coverageTick=watchOnce(source,state,{kind:"wallet",address:wallet,limit:2,clock:now});
    assert.ok(coverageTick.invalidationsQueued>=1,
      "Coverage metadata-only changes must not be silently ignored");
    const nextCoverageFingerprint=state.prepare(
      "SELECT raw_fingerprint FROM watcher_current WHERE scope=? AND signature=?"
    ).get("wallet:"+wallet,a.signature).raw_fingerprint;
    assert.notEqual(nextCoverageFingerprint,prevCoverageFingerprint);
    const coverageObservation=state.prepare(
      "SELECT audit_json FROM watcher_observations WHERE scope=? AND signature=? ORDER BY id DESC LIMIT 1"
    ).get("wallet:"+wallet,a.signature);
    assert.ok(JSON.parse(coverageObservation.audit_json).targetCoverage.length>0);
    // A -> B -> A is three distinct observed states, not an SQL UNIQUE conflict.
    const historyBeforeRevert=state.prepare("SELECT count(*) n FROM watcher_observations WHERE scope=? AND signature=?")
      .get("wallet:"+wallet,a.signature).n;
    source.prepare("UPDATE chain_forensic_history_coverage SET observed_transactions=observed_transactions-1 WHERE kind='wallet' AND address=?").run(wallet);
    const reverted=watchOnce(source,state,{kind:"wallet",address:wallet,limit:2,clock:now});
    assert.ok(reverted.invalidationsQueued>=1);
    assert.equal(state.prepare("SELECT raw_fingerprint FROM watcher_current WHERE scope=? AND signature=?")
      .get("wallet:"+wallet,a.signature).raw_fingerprint,prevCoverageFingerprint);
    assert.equal(state.prepare("SELECT count(*) n FROM watcher_observations WHERE scope=? AND signature=?")
      .get("wallet:"+wallet,a.signature).n,historyBeforeRevert+1);
    console.log("[blockchain-finality-watch] OK: durable restart, changed RAW, manual outbox, missing-signature replay, no PnL promotion");
  }finally{
    state?.close();
    source.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
run();
