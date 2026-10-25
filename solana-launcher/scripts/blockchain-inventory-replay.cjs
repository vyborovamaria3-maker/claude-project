#!/usr/bin/env node
"use strict";
// Offline read-only inventory-quality report. Never uses network or writes source DB.
const fs=require("node:fs");
const path=require("node:path");
const {gunzipSync}=require("node:zlib");
const {createHash}=require("node:crypto");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const {reconcileInventoryEvidence}=require("./blockchain-inventory-reconciliation.cjs");
const MAX_ROWS=1000, MAX_BYTES=512*1024;
function decode(row) {
  if(!Buffer.isBuffer(row.payload_gzip) || !Number.isSafeInteger(row.payload_bytes) ||
      row.payload_bytes<1 || row.payload_bytes>MAX_BYTES)throw Error("invalid_raw_size");
  if(typeof row.payload_hash!=="string"|| !/^[a-f0-9]{64}$/.test(row.payload_hash))
    throw Error("missing_trusted_raw_hash");
  const b=gunzipSync(row.payload_gzip,{maxOutputLength:row.payload_bytes});
  if(b.length!==row.payload_bytes||createHash("sha256").update(b).digest("hex")!==row.payload_hash)
    throw Error("raw_checksum_mismatch");
  const saved=JSON.parse(b.toString("utf8"));
  if(saved?.signature!==row.signature)throw Error("raw_signature_mismatch");
  if(row.slot!=null && saved.slot!=null && row.slot!==saved.slot)throw Error("raw_slot_mismatch");
  const time=saved.timestamp??saved.blockTime;
  if(row.block_time!=null&&time!=null&&row.block_time!==time)throw Error("raw_block_time_mismatch");
  const event=saved.raw?normalizeFullTransaction(saved.raw):null;
  if(!event || event.signature!==row.signature)throw Error("non_alchemy_or_unsupported_raw");
  return event;
}
function analyze(db,{limit=200}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_ROWS)throw Error("limit must be 1..1000");
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_seed_events'").get())
    throw Error("chain_seed_events missing");
  const total=db.prepare("SELECT COUNT(*) n FROM chain_seed_events").get().n;
  const result={schema:"inventory-replay-v1",authority:"diagnostic_only",fullHistoryComplete:null,
    financialLedgerEligible:false,sampledObservations:0,totalObservations:total,
    sampleTruncated:total>limit,uniqueSampleSignatures:0,
    rawInvalid:0,rawIssueReasons:{},statuses:{},accountStatusCounts:{},examples:[],
    note:"Sample covers RAW observations, not all unique transactions. MATCH is account arithmetic, never proven inventory basis."};
  const signatures=new Set();
  const cursor=db.prepare("SELECT kind,address,signature,slot,block_time,payload_hash,payload_gzip,payload_bytes FROM chain_seed_events ORDER BY kind,address,signature LIMIT ?");
  for(const row of cursor.iterate(limit)){
    result.sampledObservations++;
    signatures.add(row.signature);
    let event;
    try {event=decode(row);}
    catch(e){
      result.rawInvalid++;
      const key=String(e?.message||"unknown_raw_failure").slice(0,64);
      result.rawIssueReasons[key]=(result.rawIssueReasons[key]||0)+1;
      continue;
    }
    const r=reconcileInventoryEvidence(event);
    result.statuses[r.status]=(result.statuses[r.status]||0)+1;
    for(const [status,n] of Object.entries(r.counts))
      result.accountStatusCounts[status]=(result.accountStatusCounts[status]||0)+n;
    if(r.status!=="OBSERVED_BALANCES_MATCH_MOVEMENTS" && result.examples.length<20)
      result.examples.push({signature:r.signature,rawTarget:row.kind,inventoryStatus:r.status,
        accountMismatches:r.counts.MISMATCH,partialAccounts:r.counts.PARTIAL,
        accountConflicts:r.counts.CONFLICT,issues:r.issues.slice(0,5)});
  }
  result.uniqueSampleSignatures=signatures.size;
  return result;
}
function parse(argv) {
  let file=null, limit=200;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==="--db" && argv[i+1])file=argv[++i];
    else if(argv[i]==="--limit" && argv[i+1])limit=Number(argv[++i]);
    else throw Error("Usage: --db existing.sqlite [--limit 200]");
  }
  if(!file)throw Error("Explicit --db required");
  return {file,limit};
}
function main(argv=process.argv.slice(2)){
  const {file,limit}=parse(argv), absolute=path.resolve(file);
  if(!fs.existsSync(absolute))throw Error("Input SQLite does not exist");
  const Database=require("better-sqlite3");
  const db=new Database(absolute,{readonly:true,fileMustExist:true});
  try{db.pragma("query_only=ON");return analyze(db,{limit});}
  finally{db.close();}
}
if(require.main===module){
  try {console.log(JSON.stringify(main(),null,2));}
  catch(e){console.error(e?.message||e);process.exitCode=1;}
}
module.exports={decode,analyze,parse,main};
