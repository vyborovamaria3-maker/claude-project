#!/usr/bin/env node
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {snapshotExportRow} from './export-fomo-snapshots.mjs';
import {calculateOutcomeLabel,fetchPriceHistory,restorePriceHistory,validateSnapshotRow} from './fomo-price-joiner.mjs';

const LEASE_MS=90_000;
const RETRY_MS=15*60_000;
const TRANSIENT=new Set(['price_source_unavailable','entry_price_not_found','fixed_horizon_price_not_found','price_gap_detected','price_outcome_not_known_by_cutoff']);

export function ensureOutcomeSchema(db){
 db.pragma('foreign_keys = ON');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='fomo_score_snapshots' AND type='table'").get())throw Error('fomo_snapshot_schema_missing');
 db.exec(`
  CREATE TABLE IF NOT EXISTS fomo_price_evidence (
   sha256 TEXT PRIMARY KEY, mint TEXT NOT NULL, timeframe TEXT NOT NULL,
   fetched_at INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
  CREATE INDEX IF NOT EXISTS idx_fomo_price_evidence_token ON fomo_price_evidence(mint,timeframe,fetched_at DESC);
  CREATE TABLE IF NOT EXISTS fomo_price_outcomes (
   snapshot_id TEXT NOT NULL REFERENCES fomo_score_snapshots(snapshot_id),
   horizon_hours INTEGER NOT NULL, timeframe TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
   evidence_sha256 TEXT NOT NULL REFERENCES fomo_price_evidence(sha256),
   completed_at INTEGER NOT NULL, labelled_json TEXT NOT NULL CHECK(json_valid(labelled_json)),
   PRIMARY KEY(snapshot_id,horizon_hours,timeframe));
  CREATE TABLE IF NOT EXISTS fomo_price_attempts (
   snapshot_id TEXT NOT NULL REFERENCES fomo_score_snapshots(snapshot_id),
   horizon_hours INTEGER NOT NULL,timeframe TEXT NOT NULL,last_attempt INTEGER NOT NULL,
   next_attempt INTEGER,status TEXT NOT NULL,reason TEXT,
   PRIMARY KEY(snapshot_id,horizon_hours,timeframe));
  CREATE TABLE IF NOT EXISTS fomo_price_worker_lease (
   id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
 `);
}

function safeCode(e){return /^[a-z0-9_]{1,80}$/.test(e?.message||'')?e.message:'price_source_unavailable';}
function optionsValid({horizonHours,timeframe,limit}){
 if(!['1m','5m'].includes(timeframe))throw Error('invalid_timeframe');
 if(!Number.isSafeInteger(horizonHours)||horizonHours<1||horizonHours>(timeframe==='1m'?72:360))throw Error('invalid_horizon_hours');
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('invalid_limit');
}

export function outcomeStatus(db,{horizonHours=24,timeframe='5m',now=Date.now()}={}){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='fomo_score_snapshots' AND type='table'").get())throw Error('fomo_snapshot_schema_missing');
 const mature=now-horizonHours*3600000;
 const total=db.prepare('SELECT count(*) n FROM fomo_score_snapshots').get().n;
 const immature=db.prepare('SELECT count(*) n FROM fomo_score_snapshots WHERE signal_at>?').get(mature).n;
 const installed=db.prepare("SELECT 1 FROM sqlite_master WHERE name='fomo_price_outcomes'").get();
 const labelled=installed?db.prepare('SELECT count(*) n FROM fomo_price_outcomes WHERE horizon_hours=? AND timeframe=?').get(horizonHours,timeframe).n:0;
 const attempts=installed?db.prepare('SELECT status,count(*) n FROM fomo_price_attempts WHERE horizon_hours=? AND timeframe=? GROUP BY status').all(horizonHours,timeframe):[];
 const dueNow=installed?db.prepare(`SELECT count(*) n FROM fomo_score_snapshots s
 LEFT JOIN fomo_price_outcomes o ON o.snapshot_id=s.snapshot_id AND o.horizon_hours=? AND o.timeframe=?
 LEFT JOIN fomo_price_attempts a ON a.snapshot_id=s.snapshot_id AND a.horizon_hours=? AND a.timeframe=?
 WHERE s.signal_at<=? AND o.snapshot_id IS NULL AND (a.snapshot_id IS NULL OR a.next_attempt<=?)`)
 .get(horizonHours,timeframe,horizonHours,timeframe,mature,now).n:total-immature;
 return {snapshots:total,immature,labelled,unlabelled:total-labelled,dueNow,attempts:Object.fromEntries(attempts.map(r=>[r.status,r.n]))};
}

export async function runOutcomeBatch(db,{baseUrl='http://127.0.0.1:3000',horizonHours=24,timeframe='5m',limit=25,clock=Date.now,fetchHistory=fetchPriceHistory}={}){
 optionsValid({horizonHours,timeframe,limit});ensureOutcomeSchema(db);
 const started=clock(),owner=randomUUID();
 const acquired=db.prepare(`INSERT INTO fomo_price_worker_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE
 SET owner=excluded.owner,expires_at=excluded.expires_at WHERE fomo_price_worker_lease.expires_at<=?`).run(owner,started+LEASE_MS,started).changes;
 if(!acquired)return {status:'busy',...outcomeStatus(db,{horizonHours,timeframe,now:started})};
 function fence(){const now=clock();if(!db.prepare('UPDATE fomo_price_worker_lease SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?').run(now+LEASE_MS,owner,now).changes)throw Error('outcome_lease_lost');}
 const intervalSeconds=timeframe==='1m'?60:300;
 const report={status:'ok',horizonHours,timeframe,attempted:0,labelledThisRun:0,requests:0,cached:0,reasons:{}};
 const histories=new Map();
 try{
  const due=db.prepare(`SELECT s.* FROM fomo_score_snapshots s
   LEFT JOIN fomo_price_outcomes o ON o.snapshot_id=s.snapshot_id AND o.horizon_hours=? AND o.timeframe=?
   LEFT JOIN fomo_price_attempts a ON a.snapshot_id=s.snapshot_id AND a.horizon_hours=? AND a.timeframe=?
   WHERE s.signal_at<=? AND o.snapshot_id IS NULL
    AND (a.snapshot_id IS NULL OR a.next_attempt<=?) ORDER BY s.signal_at,s.snapshot_id LIMIT ?`)
   .all(horizonHours,timeframe,horizonHours,timeframe,started-horizonHours*3600000,started,limit);
  for(const saved of due){
   fence();report.attempted++;let history,result;
   const row=snapshotExportRow(saved);
   try{
    validateSnapshotRow(row);
    if(row.signalCoverage.x==='unknown'||row.signalCoverage.tg==='unknown')result={status:'excluded',reason:'unknown_signal_source_coverage'};
    if(!result){
     const prior=db.prepare('SELECT payload_json FROM fomo_price_evidence WHERE mint=? AND timeframe=? AND fetched_at<=? ORDER BY fetched_at DESC LIMIT 5').all(row.mint,timeframe,clock());
     for(const stored of prior){
      const candidate=restorePriceHistory(JSON.parse(stored.payload_json));
      if(candidate.mint!==row.mint||candidate.timeframe!==timeframe)throw Error('price_evidence_token_mismatch');
      const label=calculateOutcomeLabel(row,candidate,{horizonHours,cutoffAtMs:clock()});
      if(label.status==='labelled'){history=candidate;result=label;report.cached++;break;}
     }
    }
    if(!result){
     // The bounded endpoint cannot reconstruct signals outside its historical window.
     if(started-saved.signal_at>(timeframe==='1m'?72:360)*3600000)result={status:'excluded',reason:'historical_source_window_expired'};
     else{
      if(!histories.has(row.mint)){
       report.requests++;
       try{histories.set(row.mint,{history:await fetchHistory(baseUrl,row.mint,timeframe,intervalSeconds)});}
       catch(e){histories.set(row.mint,{error:safeCode(e)});}
      }
      const fetched=histories.get(row.mint);
      if(fetched.error)throw Error(fetched.error);
      // Verify persisted bytes, not just a caller-provided evidence reference.
      history=restorePriceHistory(fetched.history.evidenceRecord);
      if(history.mint!==row.mint||history.timeframe!==timeframe)throw Error('price_evidence_token_mismatch');
      result=calculateOutcomeLabel(row,history,{horizonHours,cutoffAtMs:clock()});
     }
    }
   }catch(e){result={status:'excluded',reason:safeCode(e)};}
   const completed=clock();
   db.transaction(()=>{
    fence();
    if(history)db.prepare('INSERT OR IGNORE INTO fomo_price_evidence VALUES(?,?,?,?,?)').run(history.evidenceSha256,row.mint,timeframe,history.fetchedAtMs,JSON.stringify(history.evidenceRecord));
    if(result.status==='labelled'){
     db.prepare('INSERT OR IGNORE INTO fomo_price_outcomes VALUES(?,?,?,?,?,?,?)').run(saved.snapshot_id,horizonHours,timeframe,saved.snapshot_sha256,history.evidenceSha256,completed,JSON.stringify(result.row));
     report.labelledThisRun++;
    }
    const reason=result.reason||null;
    const retry=reason&&TRANSIENT.has(reason)?completed+RETRY_MS:null;
    const status=result.status==='labelled'?'labelled':retry?'retry':'excluded';
    db.prepare(`INSERT INTO fomo_price_attempts VALUES(?,?,?,?,?,?,?) ON CONFLICT(snapshot_id,horizon_hours,timeframe)
     DO UPDATE SET last_attempt=excluded.last_attempt,next_attempt=excluded.next_attempt,status=excluded.status,reason=excluded.reason`)
     .run(saved.snapshot_id,horizonHours,timeframe,completed,retry,status,reason);
    if(reason)report.reasons[reason]=(report.reasons[reason]||0)+1;
   }).immediate();
  }
  return {...report,cutoffAt:new Date(clock()).toISOString(),...outcomeStatus(db,{horizonHours,timeframe,now:clock()})};
 }finally{db.prepare('DELETE FROM fomo_price_worker_lease WHERE id=1 AND owner=?').run(owner);}
}

export function exportOutcomeRows(db,{horizonHours=24,timeframe='5m'}={}){
 const rows=db.prepare(`SELECT o.*,s.snapshot_sha256 current_hash,e.payload_json FROM fomo_price_outcomes o
 JOIN fomo_score_snapshots s ON s.snapshot_id=o.snapshot_id JOIN fomo_price_evidence e ON e.sha256=o.evidence_sha256
 WHERE o.horizon_hours=? AND o.timeframe=? ORDER BY s.signal_at,s.snapshot_id`).all(horizonHours,timeframe);
 const evidence=new Map();
 const getSnapshot=db.prepare('SELECT * FROM fomo_score_snapshots WHERE snapshot_id=?');
 const outcomeKeys=new Set(['outcomeAt','outcomeObservedAt','outcomeEvidenceRef','forwardReturnPct','maxDrawdownPct','outcomeCoverage']);
 const labelled=rows.map(row=>{
  if(row.snapshot_sha256!==row.current_hash)throw Error('snapshot_hash_changed');
  const history=restorePriceHistory(JSON.parse(row.payload_json));
  if(history.evidenceSha256!==row.evidence_sha256)throw Error('saved_evidence_hash_mismatch');
  const label=JSON.parse(row.labelled_json);
  const original=snapshotExportRow(getSnapshot.get(row.snapshot_id));
  if(Object.keys(original).some(k=>!outcomeKeys.has(k)&&!isDeepStrictEqual(label[k],original[k])))throw Error('snapshot_hash_changed');
  if(label.outcomeEvidenceRef!==history.evidenceRef)throw Error('outcome_evidence_mismatch');
  if(label.snapshotId!==row.snapshot_id||label.snapshotSha256!==row.snapshot_sha256)throw Error('snapshot_hash_changed');
  const verified=calculateOutcomeLabel(label,history,{horizonHours,cutoffAtMs:row.completed_at});
  if(verified.status!=='labelled'||['outcomeAt','outcomeObservedAt','forwardReturnPct','maxDrawdownPct'].some(k=>label[k]!==verified.row[k]))throw Error('outcome_evidence_mismatch');
  evidence.set(history.evidenceSha256,history.evidenceRecord);return label;
 });
 return {labelled,evidence:[...evidence.values()]};
}

export function parseOutcomeArgs(argv){
 const allowed=new Set(['db','base-url','horizon-hours','timeframe','limit','output','evidence-output']);const values={};let status=false;
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--status'){if(status)throw Error('invalid_arguments');status=true;continue;}
  if(!argv[i].startsWith('--'))throw Error('invalid_arguments');
  const parts=argv[i].slice(2).split('=');const key=parts.shift(),value=parts.length?parts.join('='):argv[++i];
  if(!allowed.has(key)||!value||Object.hasOwn(values,key))throw Error('invalid_arguments');values[key]=value;
 }
 const args={db:resolve(values.db||process.env.SOLANA_TRADE_DB_PATH||'data/trade.db'),baseUrl:values['base-url']||'http://127.0.0.1:3000',horizonHours:Number(values['horizon-hours']||24),timeframe:values.timeframe||'5m',limit:Number(values.limit||25),output:values.output&&resolve(values.output),evidenceOutput:values['evidence-output']&&resolve(values['evidence-output']),status};
 optionsValid(args);const url=new URL(args.baseUrl);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('invalid_base_url');
 const paths=[args.db,args.output,args.evidenceOutput].filter(Boolean).map(p=>process.platform==='win32'?p.toLowerCase():p);
 if(new Set(paths).size!==paths.length)throw Error('output_paths_must_be_distinct');
 if(Boolean(args.output)!==Boolean(args.evidenceOutput))throw Error('both_export_paths_required');
 if(args.status&&args.output)throw Error('status_cannot_export');
 return args;
}

async function atomic(path,rows){await mkdir(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''));await rename(tmp,path);}
async function main(){
 const args=parseOutcomeArgs(process.argv.slice(2));const db=new Database(args.db,{fileMustExist:true,readonly:args.status});db.pragma('busy_timeout = 5000');
 try{
  const report=args.status?outcomeStatus(db,args):await runOutcomeBatch(db,args);
  if(args.output){const rows=exportOutcomeRows(db,args);await atomic(args.output,rows.labelled);await atomic(args.evidenceOutput,rows.evidence);}
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
 }finally{db.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{process.stderr.write(safeCode(e)+'\n');process.exitCode=1;});
