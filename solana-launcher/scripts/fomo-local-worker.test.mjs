import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {loadSnapshotRuntime,ensureLocalWorkerSchema,runLocalTick,localWorkerStatus} from './fomo-local-worker.mjs';
import {fetchPriceHistory} from './fomo-price-joiner.mjs';

const runtime=await loadSnapshotRuntime();
const MINT='So11111111111111111111111111111111111111112';
const SIGNAL=Math.floor((Date.now()-4*3600000)/300000)*300000;
function input(asOf,empty=false){return {
 x:{riskClassificationAvailable:false,botRiskScore:50,totalTweets:empty?0:1,uniqueMentioners:1,shillers:[],lastUpdated:asOf,
  topTweets:empty?[]:[{id:'test',text:'bullish '+MINT,author:'alice',timestamp:asOf-1000,likes:1,retweets:0,views:10,isSuspicious:false}],
  aggregated:{totalEngagement:1,engagementRate:0.1,verifiedAuthors:0,botRatio:0.5}},
 tg:{mentions:0,platforms:{telegram:0},timeline:[],origin:null},provenance:{source:'test_fixture'},
};}
async function history(now){
 const candles=Array.from({length:36},(_,i)=>({time:SIGNAL/1000+i*300,open:1,high:1.2,low:0.9,close:1.1,volume:10})).filter(c=>c.time*1000<=now);
 return fetchPriceHistory('http://fixture',MINT,'5m',300,async()=>Response.json({source:'bitquery',priceUnit:'USD',candles}),()=>now);
}
function fixture(){const db=new Database(':memory:');ensureLocalWorkerSchema(db,runtime);return db;}

test('captures real-source-shaped records once, restores schedule, labels only mature horizons',async()=>{
 const db=fixture();let now=SIGNAL,reads=0;
 const sources={async watchlist(){reads++;return [MINT];},async capture(_,{asOf}){return input(asOf);}};
 const opts={runtime,sources,clock:()=>now,fetchHistory:()=>history(now)};
 try{
  const first=await runLocalTick(db,opts);assert.equal(first.capture.captured,1);
  assert.equal(db.prepare('SELECT count(*) n FROM fomo_price_outcomes').get().n,0);
  assert.equal(localWorkerStatus(db,{now}).horizons[0].immature,1);
  await runLocalTick(db,opts);assert.equal(reads,1);
  now+=2*3600000;
  const mature=await runLocalTick(db,{...opts,sources:{async watchlist(){return [];}}});
  assert.equal(mature.outcomes[0].labelledThisRun,1,JSON.stringify(mature.outcomes[0]));assert.equal(mature.outcomes[1].labelledThisRun,0);
  assert.equal(mature.outcomes[2].labelledThisRun,0);
  const afterRestart=await runLocalTick(db,opts);assert.equal(afterRestart.outcomes.length,0);
 }finally{db.close();}
});

test('empty or failed social queries never turn into zero-evidence snapshots',async()=>{
 const db=fixture();
 const sources={async watchlist(){return [MINT];},async capture(){return input(SIGNAL,true);}};
 try{
  const r=await runLocalTick(db,{runtime,sources,clock:()=>SIGNAL,fetchHistory:()=>{throw Error('must_not_fetch');}});
  assert.equal(r.capture.skippedEmpty,1);assert.equal(localWorkerStatus(db).horizons[0].snapshots,0);
  db.prepare('UPDATE fomo_local_worker SET next_capture_at=0').run();
  const failed=await runLocalTick(db,{runtime,sources:{...sources,async capture(){throw Error('telegram_source_unavailable');}},clock:()=>SIGNAL});
  assert.equal(failed.capture.failed,1);assert.equal(db.prepare('SELECT count(*) n FROM fomo_score_snapshots').get().n,0);
  assert.equal(db.prepare('SELECT next_capture_at FROM fomo_local_worker').get().next_capture_at,SIGNAL+60000);
 }finally{db.close();}
});

test('concurrent workers are excluded and lease replacement fences capture writes',async()=>{
 const db=fixture();const clock=()=>SIGNAL;
 try{
  const sources={async watchlist(){return [MINT];},async capture(){
   assert.equal((await runLocalTick(db,{runtime,sources,clock})).status,'busy');
   db.prepare("UPDATE fomo_local_worker SET owner='replacement'").run();return input(SIGNAL);
  }};
  await assert.rejects(runLocalTick(db,{runtime,sources,clock}),/local_worker_lease_lost/);
  assert.equal(db.prepare('SELECT count(*) n FROM fomo_score_snapshots').get().n,0);
  assert.equal(db.prepare('SELECT owner FROM fomo_local_worker').get().owner,'replacement');
 }finally{db.close();}
});
