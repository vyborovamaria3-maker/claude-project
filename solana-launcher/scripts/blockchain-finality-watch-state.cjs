"use strict";
// Separate durable observation journal for a read-only Solana RAW collector.
// This is NOT an independent finalized consensus attestation or a reorg oracle.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const Database=require("better-sqlite3");
const {aggregate}=require("./blockchain-history-finality-audit.cjs");
const APPLICATION_ID=0x46495731; // FIW1, never a source collector DB
const VERSION=1;
const MAX_BATCH=100;
const hash=obj=>crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const real=p=>path.resolve(p);
function ensureSeparate(sourcePath,statePath){
  if(typeof sourcePath!=="string"||typeof statePath!=="string")throw Error("Explicit source and state paths required");
  const input=real(sourcePath),output=real(statePath);
  if(!fs.existsSync(input))throw Error("Source SQLite does not exist");
  if(input===output)throw Error("State must be a separate database");
  if(fs.existsSync(output)){
    const a=fs.statSync(input),b=fs.statSync(output);
    if(a.dev===b.dev&&a.ino===b.ino)throw Error("State may not be a hardlink to source");
    if(fs.realpathSync(input)===fs.realpathSync(output))throw Error("State and source resolve to the same file");
  }
  return {input,output};
}
const REQUIRED_SCHEMA={
  watcher_scopes:["scope","scan_cursor","next_sequence","last_run_at"],
  watcher_current:["scope","signature","raw_fingerprint","state","reason","source_status",
    "last_checked_sequence","last_checked_at"],
  watcher_observations:["id","scope","signature","raw_fingerprint","previous_fingerprint",
    "source_status","state","reason","checked_at","audit_json"],
  watcher_invalidation_outbox:["id","observation_id","scope","signature",
    "previous_fingerprint","new_fingerprint","reason","state","created_at"]
};
const REQUIRED_TRIGGERS=[
  "watcher_observation_immutable_update","watcher_observation_immutable_delete",
  "watcher_outbox_no_update","watcher_outbox_no_delete"
];
function validateStateSchema(db){
  if(db.pragma("application_id",{simple:true})!==APPLICATION_ID||
     db.pragma("user_version",{simple:true})!==VERSION)
    throw Error("Dedicated watcher SQLite schema required");
  for(const [name,fields] of Object.entries(REQUIRED_SCHEMA)){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if(!row||typeof row.sql!=="string")throw Error("Watcher state table missing: "+name);
    const cols=new Set(db.prepare("PRAGMA table_info("+name+")").all().map(x=>x.name));
    if(fields.some(field=>!cols.has(field)))throw Error("Watcher state columns missing: "+name);
  }
  for(const name of REQUIRED_TRIGGERS){
    const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    if(!row||typeof row.sql!=="string"||!row.sql.includes("RAISE(ABORT"))
      throw Error("Watcher immutable journal trigger missing: "+name);
  }
  const foreign=db.prepare("PRAGMA foreign_key_list(watcher_invalidation_outbox)").all();
  if(!foreign.some(x=>x.from==="observation_id" && x.table==="watcher_observations"))
    throw Error("Watcher outbox foreign key missing");
}
function openState(filename){
  const exists=fs.existsSync(filename);
  if(!exists){
    const fd=fs.openSync(filename,"wx",0o600);
    fs.closeSync(fd);
  }
  const db=new Database(filename,{fileMustExist:true,timeout:1000});
  try{
    if(!exists){
      if(db.pragma("application_id",{simple:true})!==0||
         db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n)
        throw Error("State file is not empty");
      db.transaction(()=>{
        db.exec([
        "CREATE TABLE watcher_scopes(scope TEXT PRIMARY KEY, scan_cursor TEXT, next_sequence INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER);",
        "CREATE TABLE watcher_current(",
        "scope TEXT NOT NULL,signature TEXT NOT NULL,raw_fingerprint TEXT NOT NULL,",
        "state TEXT NOT NULL,reason TEXT NOT NULL,source_status TEXT NOT NULL,",
        "last_checked_sequence INTEGER NOT NULL,last_checked_at INTEGER NOT NULL,",
        "PRIMARY KEY(scope,signature));",
        "CREATE INDEX watcher_oldest ON watcher_current(scope,last_checked_sequence,signature);",
        "CREATE TABLE watcher_observations(",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,signature TEXT NOT NULL,",
        "raw_fingerprint TEXT NOT NULL,previous_fingerprint TEXT,source_status TEXT NOT NULL,",
        "state TEXT NOT NULL,reason TEXT NOT NULL,checked_at INTEGER NOT NULL,",
        "audit_json TEXT NOT NULL);",
        "CREATE TRIGGER watcher_observation_immutable_update BEFORE UPDATE ON watcher_observations BEGIN SELECT RAISE(ABORT,'Observation journal immutable'); END;",
        "CREATE TRIGGER watcher_observation_immutable_delete BEFORE DELETE ON watcher_observations BEGIN SELECT RAISE(ABORT,'Observation journal immutable'); END;",
        "CREATE TABLE watcher_invalidation_outbox(",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,observation_id INTEGER NOT NULL,",
        "scope TEXT NOT NULL,signature TEXT NOT NULL,",
        "previous_fingerprint TEXT,new_fingerprint TEXT NOT NULL,",
        "reason TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state='pending'),",
        "created_at INTEGER NOT NULL,FOREIGN KEY(observation_id) REFERENCES watcher_observations(id));",
        "CREATE TRIGGER watcher_outbox_no_update BEFORE UPDATE ON watcher_invalidation_outbox BEGIN SELECT RAISE(ABORT,'Outbox is manual review only'); END;",
        "CREATE TRIGGER watcher_outbox_no_delete BEFORE DELETE ON watcher_invalidation_outbox BEGIN SELECT RAISE(ABORT,'Outbox is append only'); END;"
      ].join("\n"));
        db.pragma("application_id="+APPLICATION_ID);
        db.pragma("user_version="+VERSION);
      }).immediate();
    }
    validateStateSchema(db);
    if(db.pragma("journal_mode=WAL",{simple:true})!=="wal")
      throw Error("Durable watcher requires SQLite WAL");
    db.pragma("synchronous=FULL");
    db.pragma("foreign_keys=ON");
    return db;
  }catch(e){db.close();throw e;}
}
function readScope({signature=null,kind=null,address=null}={}){
  if(signature!==null) {
    if(kind!==null||address!==null)throw Error("Signature scope cannot include target");
    if(typeof signature!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(signature))
      throw Error("Invalid signature");
    return "signature:"+signature;
  }
  if(kind===null && address===null)return "global";
  if((kind===null)!==(address===null)||
    !["wallet","token","creator","dex_program"].includes(kind)||
    typeof address!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(address))
    throw Error("Invalid target scope");
  return kind+":"+address;
}
function classify(audit){
  const status=audit.status;
  if(audit.flags?.includes("SIGNATURE_NOT_OBSERVED"))
    return {state:"history_incomplete",reason:"previously_observed_signature_missing_from_source"};
  if(status==="PENDING_INDEPENDENT_FINALITY")
    return {state:"pending_independent_finality",reason:"no_independent_finality_attestation"};
  if(status==="NO_SUCCESSFUL_EXECUTION_EVIDENCE")
    return {state:"execution_not_proven",reason:"failed_or_unknown_execution"};
  if(status==="RECHECK_RAW_BEFORE_FINALITY")
    return {state:"disputed_evidence",reason:"raw_or_revision_dispute"};
  return {state:"history_incomplete",reason:"missing_or_partial_coverage"};
}
function snapshot(entry){
  const identities=(entry.recheck?.rawRevisions||[]).map(x=>({
    kind:x.kind,address:x.address,rawRevision:x.rawRevision,rawSha256:x.rawSha256,slot:x.slot
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const flags=[...(entry.flags||[])].sort();
  // Flags alone are insufficient: provider/coverage counters can change while
  // status remains "partial" or "provider_exhausted". Bind their observed
  // metadata too, without volatile timestamps or decoded transaction payloads.
  const targets=(entry.targets||[]).map(t=>({
    kind:t.kind,address:t.address,
    checkpoint:t.checkpoint?{
      backfillComplete:t.checkpoint.backfillComplete,
      possibleGap:t.checkpoint.possibleGap,
      forwardCursorPending:t.checkpoint.forwardCursorPending,
      provider:t.checkpoint.provider,
      cursorVersion:t.checkpoint.cursorVersion
    }:null,
    coverage:t.coverage?{
      status:t.coverage.status,sourceProvider:t.coverage.sourceProvider,
      observedTransactions:t.coverage.observedTransactions,
      backfillComplete:t.coverage.backfillComplete,
      possibleGap:t.coverage.possibleGap,
      forwardCursorPending:t.coverage.forwardCursorPending,
      gapReason:t.coverage.gapReason
    }:null
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const fingerprint=hash({signature:entry.signature,identities,status:entry.status,flags,
    targets,observedSlots:[...(entry.observedSlots||[])].sort((a,b)=>a-b)});
  return {fingerprint,identities,flags,targets};
}
function scanSignatures(source,scope,cursor,limit) {
  if(scope.startsWith("signature:"))return [scope.slice("signature:".length)];
  const filter=scope==="global"?null:scope.split(":");
  const sql=filter?
    "SELECT signature FROM chain_seed_events WHERE kind=? AND address=? AND signature>? ORDER BY signature LIMIT ?":
    "SELECT DISTINCT signature FROM chain_seed_events WHERE signature>? ORDER BY signature LIMIT ?";
  const cursorValue=cursor||"";
  const rows=filter?source.prepare(sql).all(filter[0],filter[1],cursorValue,limit):
    source.prepare(sql).all(cursorValue,limit);
  return rows.map(row=>row.signature);
}
function validateExistingSource(source){
  if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_seed_events'").get())
    throw Error("Expected chain_seed_events table");
}
function watchOnce(source,state,{limit=25,signature=null,kind=null,address=null,clock=Date.now}={}){
  if(!Number.isInteger(limit)||limit<1||limit>MAX_BATCH)throw Error("limit must be 1..100");
  const scope=readScope({signature,kind,address});
  validateExistingSource(source);
  if(typeof clock!=="function")throw Error("Clock required");
  const now=clock();
  if(!Number.isSafeInteger(now)||now<0)throw Error("Invalid trusted clock");
  const report={scope,version:"finality-watch-v1",authority:"diagnostic_only",
    independentFinalityVerified:false,historyComplete:false,pnlEligible:false,
    scanned:0,reviewed:0,newObservations:0,unchanged:0,invalidationsQueued:0,
    states:{},outboxExecution:"disabled_manual_review_only",
    limitations:["No RPC or consensus attestation; observations are not finalized proof.",
      "Raw revisions and status changes create a durable invalidation plan, not a reorg claim.",
      "No automatic changes to chain_wallet_trades, token_trades, inventory or PnL."]};
  source.exec("BEGIN");
  try{
    const perform=state.transaction(()=>{
      state.prepare("INSERT OR IGNORE INTO watcher_scopes(scope) VALUES(?)").run(scope);
      const meta=state.prepare("SELECT scan_cursor,next_sequence,last_run_at FROM watcher_scopes WHERE scope=?").get(scope);
      if(meta.last_run_at!==null && now<meta.last_run_at)
        throw Error("Watch clock moved backwards for scope");
      if(!Number.isSafeInteger(meta.next_sequence)||meta.next_sequence<0)
        throw Error("Invalid watcher sequence");
      const newOnes=scanSignatures(source,scope,meta.scan_cursor,limit);
      const oldOnes=state.prepare(
        "SELECT signature FROM watcher_current WHERE scope=? ORDER BY last_checked_sequence,signature LIMIT ?"
      ).all(scope,limit).map(r=>r.signature);
      const signatures=[...new Set([...newOnes,...oldOnes])];
      const current=state.prepare("SELECT * FROM watcher_current WHERE scope=? AND signature=?");
      const upsert=state.prepare([
        "INSERT INTO watcher_current(scope,signature,raw_fingerprint,state,reason,source_status,last_checked_sequence,last_checked_at)",
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,signature) DO UPDATE SET",
        "raw_fingerprint=excluded.raw_fingerprint,state=excluded.state,reason=excluded.reason,",
        "source_status=excluded.source_status,last_checked_sequence=excluded.last_checked_sequence,last_checked_at=excluded.last_checked_at"
      ].join(" "));
      const add=state.prepare([
        "INSERT INTO watcher_observations(scope,signature,raw_fingerprint,previous_fingerprint,",
        "source_status,state,reason,checked_at,audit_json) VALUES(?,?,?,?,?,?,?,?,?)"
      ].join(" "));
      const queue=state.prepare([
        "INSERT INTO watcher_invalidation_outbox(observation_id,scope,signature,previous_fingerprint,",
        "new_fingerprint,reason,created_at) VALUES(?,?,?,?,?,?,?)"
      ].join(" "));
      let seq=meta.next_sequence;
      for(const signature of signatures){
        const a=aggregate(source,{signature,limit:1}).signatures[0];
        if(!a)throw Error("Audit failed to return requested signature");
        const view=snapshot(a);
        const classified=classify(a);
        const previous=current.get(scope,signature);
        seq++;
        report.states[classified.state]=(report.states[classified.state]||0)+1;
        const changed=!previous||previous.raw_fingerprint!==view.fingerprint;
        const dispute=(classified.state==="disputed_evidence"||
          classified.state==="execution_not_proven"||
          classified.state==="history_incomplete");
        if(changed){
          // Persist only the bounded audit, not decompressed RAW, transaction
          // payloads, RPC keys, or other private wallet analytics.
          const audit={signature,status:a.status,flags:a.flags,rawRevisions:view.identities,
            targetCoverage:view.targets};
          const record=add.run(scope,signature,view.fingerprint,previous?.raw_fingerprint||null,
            a.status,classified.state,classified.reason,now,JSON.stringify(audit));
          report.newObservations++;
          if(previous||dispute){
            queue.run(record.lastInsertRowid,scope,signature,previous?.raw_fingerprint||null,
              view.fingerprint,previous?"evidence_fingerprint_or_quality_changed":"initial_evidence_unfit",now);
            report.invalidationsQueued++;
          }
        }else report.unchanged++;
        upsert.run(scope,signature,view.fingerprint,classified.state,classified.reason,a.status,seq,now);
        report.reviewed++;
      }
      const nextCursor=newOnes.length===limit?newOnes[newOnes.length-1]:null;
      state.prepare("UPDATE watcher_scopes SET scan_cursor=?,next_sequence=?,last_run_at=? WHERE scope=?")
        .run(nextCursor,seq,now,scope);
      report.scanned=newOnes.length;
      // Validate/close the source read snapshot BEFORE the state transaction
      // commits. A source snapshot close failure must roll back the outbox,
      // cursor and observation inserts together.
      source.exec("COMMIT");
    });
    perform.immediate();
    return report;
  }catch(e){
    try{source.exec("ROLLBACK");}catch{}
    throw e;
  }
}
function createOpenedSource(sourcePath){
  const db=new Database(sourcePath,{readonly:true,fileMustExist:true});
  db.pragma("query_only=ON");
  return db;
}
function runPaths({db,state,limit,signature,kind,address},options={}){
  const paths=ensureSeparate(db,state);
  const input=createOpenedSource(paths.input);
  let output;
  try{
    output=openState(paths.output);
    return watchOnce(input,output,{limit,signature,kind,address,clock:options.clock||Date.now});
  }finally{output?.close();input.close();}
}
module.exports={ensureSeparate,openState,readScope,watchOnce,runPaths,snapshot,scanSignatures};
