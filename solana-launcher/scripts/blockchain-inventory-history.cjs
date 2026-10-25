#!/usr/bin/env node
"use strict";
// Bounded offline evidence projection. Source: existing collector SQLite readonly.
// Output: NEW SQLite. No RPC, PnL changes, or certified ownership.
const fs=require("node:fs");
const path=require("node:path");
const {decode}=require("./blockchain-inventory-replay.cjs");
const {inspectLifecycle}=require("./blockchain-inventory-lifecycle.cjs");
const {assess}=require("./blockchain-inventory-readiness.cjs");
const MAX_ROWS=1000;
function project(source,out,{limit=200}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_ROWS)throw Error("limit must be 1..1000");
  if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_seed_events'").get())
    throw Error("chain_seed_events table absent");
  const total=source.prepare("SELECT COUNT(*) n FROM chain_seed_events").get().n;
  const bySignature=new Map();
  for(const row of source.prepare([
      "SELECT kind,address,signature,raw_revision,slot,block_time,",
      "payload_hash,payload_gzip,payload_bytes FROM chain_seed_events",
      "ORDER BY kind,address,signature LIMIT ?"
    ].join(" ")).iterate(limit)){
    if(typeof row.signature!=="string"||!row.signature)continue;
    const group=bySignature.get(row.signature)||{valid:[],issues:[],hashes:new Set(),copies:0};
    group.copies++;
    try{
      const event=decode(row);
      group.valid.push({row,event});
      group.hashes.add(row.payload_hash);
    }catch(e){group.issues.push(String(e?.message||"INVALID_RAW").slice(0,100));}
    bySignature.set(row.signature,group);
  }
  out.exec([
    "CREATE TABLE inventory_projection_info(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    "CREATE TABLE inventory_rejected_signatures(signature TEXT PRIMARY KEY,raw_copies INTEGER NOT NULL,reason TEXT NOT NULL);",
    "CREATE TABLE inventory_owner_observations(",
    "signature TEXT NOT NULL,account TEXT NOT NULL,slot INTEGER NOT NULL,side TEXT NOT NULL,",
    "owner TEXT NOT NULL,mint TEXT NOT NULL,raw_sha256 TEXT NOT NULL,",
    "source_kind TEXT NOT NULL,source_address TEXT NOT NULL,observation_status TEXT NOT NULL,",
    "continuity_proven INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(signature,account,side));",
    "CREATE INDEX inventory_owner_idx ON inventory_owner_observations(account,mint,slot);",
    "CREATE TABLE inventory_lifecycle_events(",
    "signature TEXT NOT NULL,slot INTEGER NOT NULL,operation_index INTEGER NOT NULL,",
    "token_account TEXT NOT NULL,event_type TEXT NOT NULL,mint TEXT,owner TEXT,",
    "status TEXT NOT NULL,reason TEXT NOT NULL,new_authority TEXT,trade_classification TEXT,",
    "rent_refund_not_fee INTEGER NOT NULL DEFAULT 0,raw_sha256 TEXT NOT NULL,",
    "PRIMARY KEY(signature,operation_index,token_account));",
    "CREATE TABLE inventory_history_issues(",
    "issue_id INTEGER PRIMARY KEY AUTOINCREMENT,signature TEXT,account TEXT,reason TEXT NOT NULL);",
    "CREATE TABLE inventory_owner_observed_spans(",
    "token_account TEXT NOT NULL,mint TEXT NOT NULL,observed_owner TEXT NOT NULL,",
    "first_observed_slot INTEGER NOT NULL,last_observed_slot INTEGER NOT NULL,",
    "distinct_observed_signatures INTEGER NOT NULL,continuity_proven INTEGER NOT NULL DEFAULT 0,",
    "status TEXT NOT NULL DEFAULT 'ENDPOINTS_ONLY',",
    "PRIMARY KEY(token_account,mint,observed_owner));"
  ].join("\n"));
  const issue=out.prepare("INSERT INTO inventory_history_issues(signature,account,reason) VALUES(?,?,?)");
  const obs=out.prepare([
    "INSERT INTO inventory_owner_observations",
    "(signature,account,slot,side,owner,mint,raw_sha256,source_kind,source_address,observation_status)",
    "VALUES(?,?,?,?,?,?,?,?,?,?)"
  ].join(" "));
  const action=out.prepare([
    "INSERT INTO inventory_lifecycle_events",
    "(signature,slot,operation_index,token_account,event_type,mint,owner,status,reason,",
    "new_authority,trade_classification,rent_refund_not_fee,raw_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ].join(" "));
  const rejected=out.prepare("INSERT INTO inventory_rejected_signatures(signature,raw_copies,reason) VALUES(?,?,?)");
  const saveSpan=out.prepare([
    "INSERT INTO inventory_owner_observed_spans",
    "(token_account,mint,observed_owner,first_observed_slot,last_observed_slot,distinct_observed_signatures)",
    "VALUES(?,?,?,?,?,?)"
  ].join(" "));
  const stats={schema:"inventory-lifecycle-evidence-v1",diagnosticOnly:true,financialLedgerEligible:false,
    sourceObservationsSampled:[...bySignature.values()].reduce((n,g)=>n+g.copies,0),
    sourceObservationsTotal:total,sampleTruncated:total>limit,uniqueSignatures:bySignature.size,
    signaturesAccepted:0,rejectedSignatures:0,duplicateTargets:0,ownerObservations:0,
    lifecycleActions:0,ownerObservedSpans:0,ownerTransitionWarnings:0,issueRows:0,
    limitations:["Observed span endpoints are not continuous slot-time ownership intervals.",
      "Sample is partial and deduplication covers selected observations only.",
      "No trade, fee, finalized-chain, FIFO or authoritative PnL conclusions."]};
  const spans=new Map();
  const accountStates=new Map();
  out.transaction(()=>{
    for(const [signature,group] of bySignature){
      if(group.issues.length||group.hashes.size!==1||!group.valid.length){
        rejected.run(signature,group.copies,group.issues.length?
          "RAW_INVALID:"+group.issues.join(","):"RAW_DIVERGENT_BETWEEN_TARGETS");
        stats.rejectedSignatures++;continue;
      }
      stats.duplicateTargets+=group.copies-1;
      const {row,event}=group.valid[0];
      const data=inspectLifecycle(event);
      stats.signaturesAccepted++;
      for(const reason of data.issues){issue.run(signature,null,reason);stats.issueRows++;}
      for(const o of data.ownerObservations){
        obs.run(signature,o.account,o.slot,o.side,o.owner,o.mint,
          row.payload_hash,row.kind,row.address,o.observationStatus);
        stats.ownerObservations++;
        const key=JSON.stringify([o.account,o.mint,o.owner]);
        const span=spans.get(key)||{account:o.account,mint:o.mint,owner:o.owner,
          first:o.slot,last:o.slot,signatures:new Set()};
        span.first=Math.min(span.first,o.slot);
        span.last=Math.max(span.last,o.slot);
        span.signatures.add(signature);spans.set(key,span);
        const account=accountStates.get(o.account)||new Map();
        const state=account.get(o.slot)||new Set();
        state.add(JSON.stringify([o.owner,o.mint]));
        account.set(o.slot,state);accountStates.set(o.account,account);
      }
      for(const a of data.actions){
        action.run(signature,a.slot,a.operationIndex,a.account,a.eventType,a.mint,a.owner,
          a.status,a.reason,a.newAuthority||null,a.tradeClassification||null,
          a.rentRefundNotFee?1:0,row.payload_hash);
        stats.lifecycleActions++;
      }
    }
    for(const span of spans.values()){
      saveSpan.run(span.account,span.mint,span.owner,span.first,span.last,span.signatures.size);
      stats.ownerObservedSpans++;
    }
    for(const [account,slots] of accountStates){
      const fingerprints=new Set();
      for(const vals of slots.values()){
        for(const v of vals)fingerprints.add(v);
        if(vals.size>1){
          issue.run(null,account,"CONFLICTING_OWNER_OR_MINT_AT_SAME_SLOT");stats.issueRows++;
        }
      }
      if(fingerprints.size>1){
        issue.run(null,account,"OWNER_OR_MINT_CHANGED_BETWEEN_OBSERVED_ENDPOINTS_UNPROVEN");
        stats.ownerTransitionWarnings++;stats.issueRows++;
      }
    }
    stats.readiness=assess(source,stats);
    out.prepare("INSERT INTO inventory_projection_info(key,value) VALUES(?,?)")
      .run("manifest",JSON.stringify({...stats,builtAt:new Date().toISOString()}));
  })();
  return stats;
}
function parse(argv){
  const a={limit:200};
  for(let i=0;i<argv.length;i++){
    if(["--db","--out","--limit"].includes(argv[i])&&argv[i+1]){
      const k=argv[i].slice(2);a[k]=argv[++i];
    }else throw Error("Usage: --db EXISTING.sqlite --out NEW.sqlite [--limit 200]");
  }
  if(!a.db||!a.out)throw Error("Both --db and --out are required");
  a.limit=Number(a.limit);
  if(!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>MAX_ROWS)throw Error("Invalid limit");
  return a;
}
function main(argv=process.argv.slice(2)){
  const a=parse(argv),sourcePath=path.resolve(a.db),outPath=path.resolve(a.out);
  if(!fs.existsSync(sourcePath)||fs.existsSync(outPath)||sourcePath===outPath)
    throw Error("Input DB must exist and output DB must not exist");
  const D=require("better-sqlite3");
  const source=new D(sourcePath,{readonly:true,fileMustExist:true});
  let out,ownsOutput=false;
  try{
    source.pragma("query_only=ON");
    const fd=fs.openSync(outPath,"wx");
    ownsOutput=true;
    fs.closeSync(fd);
    out=new D(outPath,{fileMustExist:false});
    const report=project(source,out,{limit:a.limit});
    return {...report,output:outPath};
  }catch(err){
    out?.close();out=null;
    if(ownsOutput&&fs.existsSync(outPath))fs.unlinkSync(outPath);
    throw err;
  }finally{out?.close();source.close();}
}
if(require.main===module){
  try{console.log(JSON.stringify(main(),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={project,parse,main};
