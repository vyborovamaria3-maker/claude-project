#!/usr/bin/env node
// Node 24. Application worker only: no AI calls, browser sessions or source writes.
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {parse as parseEnv} from 'dotenv';
import {runOutcomeBatch,outcomeStatus,ensureOutcomeSchema} from './fomo-outcomes.mjs';
import {createLocalSocialSources} from './fomo-local-social.mjs';
import {fetchGeckoPriceHistory} from './fomo-gecko-prices.mjs';
import {restorePriceHistory} from './fomo-price-joiner.mjs';

export const CAPTURE_MS=15*60_000;
const LEASE_MS=120_000;
const code=e=>/^[a-z0-9_]{1,80}$/.test(e?.message||'')?e.message:'local_worker_failed';

export async function loadSnapshotRuntime(){
 // Native TS stripping preserves a single score implementation without new deps.
 // Limit extension resolution to this module tree; deregister after imports.
 const root=new URL('../lib/trade/',import.meta.url).href;
 const hook=registerHooks({resolve(specifier,context,next){
  if(context.parentURL?.startsWith(root)&&specifier.startsWith('./')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);
  return next(specifier,context);
 }});
 try{
  const [builder,schema,store]=await Promise.all([
   import('../lib/trade/fomo-snapshot.ts'),import('../lib/trade/fomo-snapshot-schema.ts'),import('../lib/trade/fomo-snapshot-store.ts'),
  ]);
  return {...builder,...schema,insertFomoSnapshotWithDb:store.insertFomoSnapshotWithDb};
 }finally{hook.deregister();}
}

export function ensureLocalWorkerSchema(db,runtime){
 runtime.ensureFomoSnapshotSchema(db);ensureOutcomeSchema(db);
 db.exec(`CREATE TABLE IF NOT EXISTS fomo_local_worker (
  id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
  next_capture_at INTEGER NOT NULL DEFAULT 0,next_outcome_at INTEGER NOT NULL DEFAULT 0,
  last_tick_at INTEGER,last_capture_at INTEGER,last_outcome_at INTEGER,last_error TEXT);
 INSERT OR IGNORE INTO fomo_local_worker(id) VALUES(1);`);
}

export async function runLocalTick(db,{runtime,sources,fetchHistory=fetchGeckoPriceHistory,
 clock=Date.now,watchLimit=12,horizons=[1,6,24],outcomeLimit=12,baseUrl='http://127.0.0.1:3100'}={}){
 const owner=randomUUID(),now=clock();
 const acquired=db.prepare('UPDATE fomo_local_worker SET owner=?,lease_until=? WHERE id=1 AND lease_until<=?').run(owner,now+LEASE_MS,now).changes;
 if(!acquired)return {status:'busy'};
 function fence(){const t=clock();if(!db.prepare('UPDATE fomo_local_worker SET lease_until=? WHERE id=1 AND owner=? AND lease_until>?').run(t+LEASE_MS,owner,t).changes)throw Error('local_worker_lease_lost');}
 let leaseLost=false;
 const heartbeat=setInterval(()=>{try{fence();}catch{leaseLost=true;}},30_000);heartbeat.unref();
 const report={status:'ok',capture:{captured:0,duplicates:0,skippedEmpty:0,failed:0,reasons:{}},outcomes:[]};
 try{
  const state=db.prepare('SELECT * FROM fomo_local_worker WHERE id=1').get();
  if(state.next_capture_at<=now){
   // Interrupted attempts stay visible and can be retried after lease recovery.
   db.prepare("UPDATE fomo_snapshot_capture_runs SET status='failed',completed_at=?,failure_code='worker_interrupted' WHERE status='running' AND requested_at<?")
    .run(now,now-LEASE_MS);
   const mints=await sources.watchlist({limit:watchLimit,asOf:clock()});fence();
   report.watchlist=mints;
   const newMints=[];
   for(const mint of mints){
    fence();const requested=clock(),bucket=runtime.fomoCaptureBucketStart(requested);
    if(db.prepare('SELECT 1 FROM fomo_score_snapshots WHERE canonical_token_id=? AND score_version=? AND bucket_start_at=?').get('solana:'+mint,runtime.FOMO_LOCAL_SCORE_VERSION,bucket)){
     report.capture.duplicates++;continue;
    }
    const id=randomUUID();
    db.prepare("INSERT INTO fomo_snapshot_capture_runs(run_id,mint,requested_at,status,created_at) VALUES(?,?,?,'running',?)").run(id,mint,requested,requested);
    try{
     const input=await sources.capture(mint,{asOf:requested});fence();
     const completed=clock();
     if(input.x.topTweets.length+input.tg.timeline.length===0){
      db.prepare("UPDATE fomo_snapshot_capture_runs SET status='failed',completed_at=?,x_status='available',tg_status='available',failure_code='no_recent_social_evidence' WHERE run_id=?").run(completed,id);
      report.capture.skippedEmpty++;continue;
     }
     const snapshot=runtime.buildFomoSnapshotRecord({mint,x:input.x,tg:input.tg,signalAt:completed,source:'local_collector_db',provenance:input.provenance});
     db.transaction(()=>{
      fence();const saved=runtime.insertFomoSnapshotWithDb(db,snapshot);
      db.prepare("UPDATE fomo_snapshot_capture_runs SET status=?,completed_at=?,x_status='available',tg_status='available',snapshot_id=? WHERE run_id=?")
       .run(saved.inserted?'captured':'duplicate',completed,saved.snapshotId,id);
      report.capture[saved.inserted?'captured':'duplicates']++;
      if(saved.inserted)newMints.push(mint);
     }).immediate();
    }catch(e){
     if(leaseLost||e.message==='local_worker_lease_lost')throw e;
     fence();const reason=code(e);
     db.prepare("UPDATE fomo_snapshot_capture_runs SET status='failed',completed_at=?,failure_code=? WHERE run_id=?").run(clock(),reason,id);
     report.capture.failed++;report.capture.reasons[reason]=(report.capture.reasons[reason]||0)+1;
    }
   }
   fence();
   db.prepare('UPDATE fomo_local_worker SET next_capture_at=?,last_capture_at=? WHERE id=1 AND owner=?')
    .run(clock()+(report.capture.failed?60_000:CAPTURE_MS),clock(),owner);
   // A bounded initial price probe verifies the actual token/provider immediately.
   // It is evidence only; immature snapshots never receive a return label.
   report.priceProbe={saved:0,failed:0,reasons:{}};
   for(const mint of newMints.slice(0,2)){
    try{
     const history=restorePriceHistory((await fetchHistory(baseUrl,mint,'5m',300)).evidenceRecord);fence();
     if(history.mint!==mint||history.mock||history.priceUnit!=='USD'||!history.candles.length)throw Error('price_source_unavailable');
     db.prepare('INSERT OR IGNORE INTO fomo_price_evidence VALUES(?,?,?,?,?)').run(history.evidenceSha256,mint,'5m',history.fetchedAtMs,JSON.stringify(history.evidenceRecord));
     report.priceProbe.saved++;
    }catch(e){
     if(leaseLost||e.message==='local_worker_lease_lost')throw e;
     report.priceProbe.failed++;
     const reason=code(e);report.priceProbe.reasons[reason]=(report.priceProbe.reasons[reason]||0)+1;
    }
   }
  }
  if(state.next_outcome_at<=now){
   for(const horizonHours of horizons){
    fence();report.outcomes.push(await runOutcomeBatch(db,{baseUrl,horizonHours,timeframe:'5m',limit:outcomeLimit,clock,fetchHistory,maxSourceAgeHours:80}));
   }
   fence();db.prepare('UPDATE fomo_local_worker SET next_outcome_at=?,last_outcome_at=? WHERE id=1 AND owner=?').run(clock()+5*60_000,clock(),owner);
  }
  if(report.capture.failed)report.status='partial';
  fence();db.prepare('UPDATE fomo_local_worker SET last_tick_at=?,last_error=CASE WHEN ? THEN ? ELSE last_error END WHERE id=1 AND owner=?')
   .run(clock(),state.next_capture_at<=now?1:0,report.capture.failed?'partial_capture_failure':null,owner);
  return report;
 }catch(e){
  if(!leaseLost&&e.message!=='local_worker_lease_lost'){
   fence();db.prepare('UPDATE fomo_local_worker SET last_tick_at=?,last_error=?,next_capture_at=? WHERE id=1 AND owner=?').run(clock(),code(e),clock()+60_000,owner);
  }
  throw e;
 }finally{clearInterval(heartbeat);db.prepare('UPDATE fomo_local_worker SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?').run(owner);}
}

export function localWorkerStatus(db,{horizons=[1,6,24],now=Date.now()}={}){
 const state=db.prepare('SELECT next_capture_at,next_outcome_at,last_tick_at,last_capture_at,last_outcome_at,last_error FROM fomo_local_worker WHERE id=1').get();
 const first=db.prepare('SELECT min(signal_at) first FROM fomo_score_snapshots').get().first;
 const recent=db.prepare('SELECT mint,signal_at,fomo_pressure,fomo_quality,quality_coverage,x_sample_count,tg_sample_count,source_meta_json FROM fomo_score_snapshots ORDER BY signal_at DESC LIMIT 12').all();
 return {checkedAt:new Date(now).toISOString(),worker:state,firstOutcomeDueAt:first?new Date(first+Math.min(...horizons)*3600000).toISOString():null,
  horizons:horizons.map(horizonHours=>({horizonHours,...outcomeStatus(db,{horizonHours,timeframe:'5m',now})})),recent,
  priceEvidence:db.prepare('SELECT count(*) records,count(DISTINCT mint) tokens,max(fetched_at) latest_at FROM fomo_price_evidence').get(),
  recentCaptureFailures:db.prepare("SELECT mint,failure_code,completed_at FROM fomo_snapshot_capture_runs WHERE status='failed' ORDER BY requested_at DESC LIMIT 12").all()};
}

async function atomicJson(path,value){await mkdir(dirname(path),{recursive:true});const tmp=path+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n','utf8');await rename(tmp,path);}

export async function main(configPath){
 const cfg=JSON.parse((await readFile(resolve(configPath),'utf8')).replace(/^\uFEFF/,''));
 if(!cfg.db||!cfg.sourceEnv||!cfg.xEnv||!cfg.statusFile)throw Error('invalid_local_worker_config');
 const env=parseEnv(await readFile(cfg.sourceEnv,'utf8')),xEnv=parseEnv(await readFile(cfg.xEnv,'utf8'));
 const sources=createLocalSocialSources({xConnectionString:xEnv.DATABASE_URL,tgConnectionString:env.TG_COLLECTOR_DATABASE_URL});
 const runtime=await loadSnapshotRuntime();
 const db=new Database(resolve(cfg.db),{fileMustExist:true});db.pragma('busy_timeout=5000');
 ensureLocalWorkerSchema(db,runtime);
 let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
 try{
  do{
   let report;try{report=await runLocalTick(db,{runtime,sources,watchLimit:cfg.watchLimit||12,outcomeLimit:cfg.outcomeLimit||12});}
   catch(e){report={status:'retry',reason:code(e)};}
   const saved=localWorkerStatus(db);
   const previousSources=saved.recent[0]?JSON.parse(saved.recent[0].source_meta_json).provenance?.corpusStatus:null;
   const status={...saved,sources:sources.status()||previousSources||null,lastCycle:report};
   await atomicJson(resolve(cfg.statusFile),status);
   if(report.capture||report.status!=='ok')console.log(JSON.stringify({checkedAt:status.checkedAt,...report}));
   if(cfg.once)break;
   await delay(30_000);
  }while(!stopping);
 }finally{await sources.close();db.close();}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const i=process.argv.indexOf('--config');
 if(i<0||!process.argv[i+1])throw Error('local_worker_config_required');
 main(process.argv[i+1]).catch(e=>{console.error(code(e));process.exitCode=1;});
}
