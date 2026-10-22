#!/usr/bin/env node
"use strict";
// Independent READ-ONLY historical-evidence audit. No RPC credentials, network,
// database migrations, finality promotion or canonical PnL writes.
const fs=require("node:fs");
const path=require("node:path");
const {decode}=require("./blockchain-inventory-replay.cjs");
const MAX_SIGNATURES=200, MAX_TARGETS=20, MAX_REVISIONS=32;
const VERSION="history-finality-audit-v1";
function tableExists(db,name){
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(db,name){
  return new Set(db.prepare("PRAGMA table_info("+name+")").all().map(c=>c.name));
}
function exactUnsigned(value){return Number.isSafeInteger(value)&&value>0;}
function checkTarget(db,kind,address,lookup) {
  const reasons=[];
  let checkpoint=null,coverage=null;
  if(lookup.target){
    const r=lookup.target.get(kind,address);
    if(!r)reasons.push("COLLECTOR_TARGET_MISSING");
    else{
      checkpoint={
        backfillComplete:r.backfill_complete===1,
        possibleGap:r.possible_gap!==0,
        forwardCursorPending:Boolean(r.forward_cursor),
        provider:r.collection_provider||null,
        cursorVersion:r.cursor_version??null
      };
      if(!checkpoint.backfillComplete)reasons.push("BACKFILL_NOT_EXHAUSTED");
      if(checkpoint.possibleGap)reasons.push("COLLECTOR_POSSIBLE_GAP");
      if(checkpoint.forwardCursorPending)reasons.push("FORWARD_CATCHUP_PENDING");
      if(r.last_error)reasons.push("COLLECTOR_REPORTED_ERROR");
      if(r.raw_history_seen)reasons.push("RAW_HISTORY_DECODER_COVERAGE_INCOMPLETE");
    }
  }else reasons.push("COLLECTOR_TARGET_TABLE_UNAVAILABLE");
  if(lookup.coverage){
    const c=lookup.coverage.get(kind,address);
    if(!c)reasons.push("FORENSIC_COVERAGE_MISSING");
    else{
      coverage={status:c.coverage_status,sourceProvider:c.source_provider,
        observedTransactions:c.observed_transactions,
        backfillComplete:c.backfill_complete===1,
        possibleGap:c.possible_gap!==0,
        forwardCursorPending:c.forward_cursor_pending!==0,
        gapReason:c.gap_reason||null};
      if(c.coverage_status!=="provider_exhausted"||c.backfill_complete!==1||c.possible_gap!==0||
        c.forward_cursor_pending!==0)reasons.push("FORENSIC_COVERAGE_INCOMPLETE");
    }
  }else reasons.push("FORENSIC_COVERAGE_TABLE_UNAVAILABLE");
  if(checkpoint?.provider && coverage?.sourceProvider &&
    checkpoint.provider!==coverage.sourceProvider)reasons.push("PROVIDER_CHECKPOINT_DISAGREEMENT");
  return {kind,address,checkpoint,coverage,flags:[...new Set(reasons)]};
}
function inspectRevisionChain(row,query){
  const flags=[];
  if(!exactUnsigned(row.raw_revision))return ["CURRENT_REVISION_INVALID"];
  if(!query)return ["RAW_REVISION_ARCHIVE_UNAVAILABLE"];
  if(row.raw_revision>MAX_REVISIONS)return ["REVISION_HISTORY_EXCEEDS_AUDIT_LIMIT"];
  const versions=query.all(row.kind,row.address,row.signature,MAX_REVISIONS+1);
  if(versions.length>MAX_REVISIONS)flags.push("REVISION_HISTORY_EXCEEDS_AUDIT_LIMIT");
  const byNumber=new Map();
  for(const revision of versions){
    if(!exactUnsigned(revision.raw_revision)||byNumber.has(revision.raw_revision))
      flags.push("REVISION_ID_INVALID_OR_DUPLICATE");
    else byNumber.set(revision.raw_revision,revision);
    try{decode(revision);}
    catch{flags.push("ARCHIVED_RAW_HASH_OR_FIELDS_INVALID");}
  }
  const current=byNumber.get(row.raw_revision);
  if(!current)flags.push("CURRENT_RAW_REVISION_NOT_ARCHIVED");
  else if(current.payload_hash!==row.payload_hash||current.slot!==row.slot||
    current.block_time!==row.block_time||current.payload_bytes!==row.payload_bytes||
    !Buffer.from(current.payload_gzip).equals(Buffer.from(row.payload_gzip)))
    flags.push("CURRENT_RAW_ARCHIVE_CONFLICT");
  for(let n=1;n<=row.raw_revision;n++){
    if(!byNumber.has(n)){flags.push("HISTORICAL_RAW_REVISION_NOT_RETAINED");break;}
  }
  if([...byNumber.keys()].some(n=>n>row.raw_revision))
    flags.push("ARCHIVED_REVISION_AHEAD_OF_CURRENT");
  if(new Set(versions.map(x=>x.payload_hash)).size>1)
    flags.push("RAW_REWRITE_OR_CORRECTION_OBSERVED");
  return [...new Set(flags)];
}
function aggregate(source,{limit=50,signature=null}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_SIGNATURES)
    throw Error("limit must be between 1 and 200");
  if(signature!==null && (typeof signature!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(signature)))
    throw Error("signature must be a Solana base58 identifier");
  if(!tableExists(source,"chain_seed_events"))throw Error("chain_seed_events table missing");
  const names=columns(source,"chain_seed_events");
  const required=["kind","address","signature","raw_revision","slot","block_time","payload_gzip","payload_hash","payload_bytes"];
  if(required.some(n=>!names.has(n)))throw Error("unsupported chain_seed_events schema");
  const revisionTable=tableExists(source,"chain_seed_raw_revisions");
  const availableRevisions=revisionTable &&
    ["kind","address","signature","raw_revision","slot","block_time","payload_gzip","payload_hash","payload_bytes"]
      .every(k=>columns(source,"chain_seed_raw_revisions").has(k));
  const targetTable=tableExists(source,"chain_seed_targets");
  const targetCols=targetTable?columns(source,"chain_seed_targets"):new Set();
  const targetOK=["kind","address","backfill_complete","possible_gap"].every(k=>targetCols.has(k));
  const coverageTable=tableExists(source,"chain_forensic_history_coverage");
  const coverageCols=coverageTable?columns(source,"chain_forensic_history_coverage"):new Set();
  const coverageOK=["kind","address","coverage_status","source_provider","observed_transactions",
    "backfill_complete","possible_gap","forward_cursor_pending","gap_reason"].every(k=>coverageCols.has(k));
  const targetFields=[
    "backfill_complete","possible_gap",
    ...["forward_cursor","collection_provider","cursor_version","last_error","raw_history_seen"]
      .filter(k=>targetCols.has(k))
  ];
  const lookup={
    target:targetOK?source.prepare("SELECT "+targetFields.join(",")+" FROM chain_seed_targets WHERE kind=? AND address=?"):null,
    coverage:coverageOK?source.prepare(
      "SELECT coverage_status,source_provider,observed_transactions,backfill_complete,possible_gap,forward_cursor_pending,gap_reason FROM chain_forensic_history_coverage WHERE kind=? AND address=?"):null,
    revisions:availableRevisions?source.prepare(
      "SELECT kind,address,signature,raw_revision,slot,block_time,payload_gzip,payload_hash,payload_bytes FROM chain_seed_raw_revisions WHERE kind=? AND address=? AND signature=? ORDER BY raw_revision LIMIT ?"):null
  };
  // All copies for each selected signature must be considered together.
  // Unlike LIMIT over target rows, this cannot silently omit a second target.
  const ids=signature?[{signature}]:source.prepare(
    "SELECT DISTINCT signature FROM chain_seed_events ORDER BY signature LIMIT ?").all(limit+1);
  const truncated=!signature&&ids.length>limit;
  const chosen=ids.slice(0,limit);
  const copies=source.prepare(
    "SELECT kind,address,signature,raw_revision,slot,block_time,payload_gzip,payload_hash,payload_bytes FROM chain_seed_events WHERE signature=? ORDER BY kind,address LIMIT ?");
  const output={version:VERSION,authority:"diagnostic_only",finalityVerified:false,
    historyComplete:false,pnlEligible:false,distinctSignaturesSampled:chosen.length,
    sampleTruncated:truncated,byStatus:{},signatures:[],
    globalLimitations:["Finalized RPC request configuration is not independently attested RPC or consensus finality.",
      "Provider pagination exhaustion does not establish account-wide token history or decoder completeness.",
      "Observation-time RAW consistency cannot prove rollback/reorg stability or continuous wallet ownership.",
      "No API calls, no verified finalized slot, no changes to token_trades, PnL or collector state."]};
  for(const item of chosen) {
    const signature=item.signature;
    const rows=copies.all(signature,MAX_TARGETS+1);
    const reasons=[],targets=[],hashes=new Set(),slots=new Set();
    let hasFailed=false,hasSuccessful=false,rawValid=0;
    if(rows.length>MAX_TARGETS)reasons.push("TOO_MANY_TARGET_COPIES_TO_AUDIT");
    for(const row of rows.slice(0,MAX_TARGETS)){
      targets.push(checkTarget(source,row.kind,row.address,lookup));
      if(!exactUnsigned(row.raw_revision))reasons.push("CURRENT_REVISION_INVALID");
      try{
        const normalized=decode(row);
        rawValid++;
        hashes.add(row.payload_hash);
        slots.add(row.slot);
        if(normalized.transactionError===null)hasSuccessful=true;
        else if(normalized.transactionError!==undefined)hasFailed=true;
        else reasons.push("EXECUTION_STATUS_UNKNOWN");
      }catch{
        reasons.push("CURRENT_RAW_CORRUPT_OR_UNSUPPORTED");
      }
      for(const r of inspectRevisionChain(row,lookup.revisions))reasons.push(r);
    }
    if(rows.length===0)reasons.push("SIGNATURE_NOT_OBSERVED");
    if(hashes.size>1||slots.size>1)reasons.push("CROSS_TARGET_RAW_OR_SLOT_DISAGREEMENT");
    if(hasFailed&&hasSuccessful)reasons.push("EXECUTION_RESULT_DISAGREEMENT");
    if(!hasSuccessful&&!hasFailed)reasons.push("EXECUTION_STATUS_UNRESOLVED");
    for(const target of targets)reasons.push(...target.flags);
    const unique=[...new Set(reasons)].sort();
    let status="PENDING_INDEPENDENT_FINALITY";
    if(unique.some(x=>/CORRUPT|INVALID|CONFLICT|DISAGREEMENT|TOO_MANY|NOT_RETAINED|UNSUPPORTED|REWRITE/.test(x)))
      status="RECHECK_RAW_BEFORE_FINALITY";
    else if(!hasSuccessful)status="NO_SUCCESSFUL_EXECUTION_EVIDENCE";
    else if(unique.length)status="INCOMPLETE_HISTORY_OR_REVISIONS";
    output.byStatus[status]=(output.byStatus[status]||0)+1;
    output.signatures.push({signature,status,observationCopies:rows.length,
      validatedCopies:rawValid,distinctRawHashes:hashes.size,observedSlots:[...slots],
      flags:unique,targets,recheck:{
        signature,
        reason:"independent_finality_and_history_coverage_required",
        // Sampled RAW is not a finality witness. These are binding hints only.
        rawRevisions:rows.slice(0,MAX_TARGETS).map(r=>({
          kind:r.kind,address:r.address,rawRevision:r.raw_revision,
          rawSha256:r.payload_hash,slot:r.slot}))
      },finalityEvidence:"NOT_INDEPENDENTLY_ATTESTED"});
  }
  return output;
}
function parse(argv){
  const a={limit:50,signature:null,db:null};
  for(let i=0;i<argv.length;i++){
    if(["--db","--limit","--signature"].includes(argv[i])&&argv[i+1]){
      a[argv[i].slice(2)]=argv[++i];
    }else throw Error("Usage: --db existing.sqlite [--limit 50] [--signature BASE58]");
  }
  if(!a.db)throw Error("Explicit --db existing file required");
  a.limit=Number(a.limit);
  return a;
}
function main(argv=process.argv.slice(2)){
  const args=parse(argv);
  const file=path.resolve(args.db);
  if(!fs.existsSync(file))throw Error("Input SQLite does not exist");
  const Database=require("better-sqlite3");
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try{db.pragma("query_only=ON");return aggregate(db,args);}
  finally{db.close();}
}
if(require.main===module){
  try{console.log(JSON.stringify(main(),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={aggregate,main,parse,checkTarget,inspectRevisionChain};
