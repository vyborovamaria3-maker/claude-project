import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {fetchPriceHistory} from './fomo-price-joiner.mjs';
import {runOutcomeBatch,exportOutcomeRows,ensureOutcomeSchema,parseOutcomeArgs} from './fomo-outcomes.mjs';

const SIGNAL=Date.parse('2026-10-27T00:00:00Z');
const MINT='So11111111111111111111111111111111111111112';
function sourceRow(id,signal=SIGNAL){return {snapshot_id:id,canonical_token_id:'solana:'+MINT,mint:MINT,signal_at:signal,max_input_observed_at:signal,score_version:'v1',fomo_pressure:75,fomo_quality:60,quality_coverage:0.8,x_coverage:'partial',tg_coverage:'partial',source_coverage_known_at:signal,source_meta_json:'{}',capture_config_json:'{}',x_input_sha256:'a'.repeat(64),tg_input_sha256:'b'.repeat(64),input_sha256:'c'.repeat(64),snapshot_sha256:'d'.repeat(64)};}
function fixture(rows){
 const db=new Database(':memory:');const columns=Object.keys(sourceRow('s'));
 db.exec('CREATE TABLE fomo_score_snapshots('+columns.map(k=>k+(k==='snapshot_id'?' TEXT PRIMARY KEY':typeof sourceRow('s')[k]==='number'?' NUMERIC':' TEXT')).join(',')+')');
 const insert=db.prepare('INSERT INTO fomo_score_snapshots VALUES('+columns.map(()=>'?').join(',')+')');for(const row of rows)insert.run(...columns.map(k=>row[k]));return db;
}
async function history(now){
 const candles=Array.from({length:40},(_,i)=>({time:SIGNAL/1000+i*300,open:1+i/100,high:1.1+i/100,low:0.9+i/100,close:1.01+i/100,volume:10}));
 return fetchPriceHistory('http://test',MINT,'5m',300,async()=>new Response(JSON.stringify({source:'bitquery',priceUnit:'USD',candles}),{headers:{'content-type':'application/json'}}),()=>now);
}

test('mature snapshots share one request; immutable outcomes survive restart and can be exported',async()=>{
 const db=fixture([sourceRow('one'),sourceRow('two',SIGNAL+900000),sourceRow('future',SIGNAL+86400000)]);let requests=0;const clock=()=>SIGNAL+4*3600000;
 try{
  const opts={horizonHours:1,clock,fetchHistory:async()=>{requests++;return history(clock());}};
  const first=await runOutcomeBatch(db,opts);assert.equal(first.labelledThisRun,2);assert.equal(first.immature,1);assert.equal(requests,1);
  const exported=exportOutcomeRows(db,{horizonHours:1});assert.equal(exported.labelled.length,2);assert.equal(exported.evidence.length,1);
  assert(exported.labelled.every(r=>r.forwardReturnPct>0&&r.maxDrawdownPct<=0&&r.outcomeCoverage.price==='complete'));
  const again=await runOutcomeBatch(db,opts);assert.equal(again.attempted,0);assert.equal(requests,1);assert.deepEqual(exportOutcomeRows(db,{horizonHours:1}),exported);
  const shorter=await runOutcomeBatch(db,{...opts,horizonHours:2});assert.equal(shorter.labelledThisRun,2);assert.equal(shorter.requests,0);assert.equal(shorter.cached,2);
 }finally{db.close();}
});

test('immature and unknown-source signals do not cause paid source requests',async()=>{
 const db=fixture([{...sourceRow('unknown'),x_coverage:'unknown'},sourceRow('future',SIGNAL+86400000)]);
 try{const r=await runOutcomeBatch(db,{horizonHours:1,clock:()=>SIGNAL+7200000,fetchHistory:async()=>{throw Error('must_not_fetch');}});assert.equal(r.requests,0);assert.equal(r.labelledThisRun,0);assert.equal(r.reasons.unknown_signal_source_coverage,1);assert.equal(r.immature,1);}finally{db.close();}
});

test('source failure is retried after its checkpoint, never imputed as zero',async()=>{
 const db=fixture([sourceRow('one')]);let now=SIGNAL+4*3600000;const clock=()=>now;
 try{
  const first=await runOutcomeBatch(db,{horizonHours:1,clock,fetchHistory:async()=>{throw Error('price_source_unavailable');}});assert.equal(first.attempts.retry,1);assert.equal(first.labelled,0);
  const notDue=await runOutcomeBatch(db,{horizonHours:1,clock,fetchHistory:async()=>{throw Error('must_not_fetch');}});assert.equal(notDue.requests,0);
  now+=16*60000;const recovered=await runOutcomeBatch(db,{horizonHours:1,clock,fetchHistory:()=>history(now)});assert.equal(recovered.labelledThisRun,1);
 }finally{db.close();}
});

test('parallel workers are excluded and an expired owner cannot publish results',async()=>{
 const db=fixture([sourceRow('one')]);const clock=()=>SIGNAL+4*3600000;
 try{
  await assert.rejects(runOutcomeBatch(db,{horizonHours:1,clock,fetchHistory:async()=>{
   const parallel=await runOutcomeBatch(db,{horizonHours:1,clock});assert.equal(parallel.status,'busy');
   db.prepare('UPDATE fomo_price_worker_lease SET owner=?').run('replacement');return history(clock());
  }}),/outcome_lease_lost/);
  assert.equal(db.prepare('SELECT count(*) n FROM fomo_price_outcomes').get().n,0);
 }finally{db.close();}
});

test('tampered saved candles or changed snapshot identity fail closed on export',async()=>{
 const db=fixture([sourceRow('one')]);const clock=()=>SIGNAL+4*3600000;
 try{
  await runOutcomeBatch(db,{horizonHours:1,clock,fetchHistory:()=>history(clock())});
  const label=JSON.parse(db.prepare('SELECT labelled_json FROM fomo_price_outcomes').get().labelled_json);
  db.prepare('UPDATE fomo_price_outcomes SET labelled_json=?').run(JSON.stringify({...label,fomoQuality:99}));
  assert.throws(()=>exportOutcomeRows(db,{horizonHours:1}),/snapshot_hash_changed/);
  db.prepare('UPDATE fomo_price_outcomes SET labelled_json=?').run(JSON.stringify(label));
  db.prepare('UPDATE fomo_score_snapshots SET snapshot_sha256=?').run('e'.repeat(64));assert.throws(()=>exportOutcomeRows(db,{horizonHours:1}),/snapshot_hash_changed/);
  db.prepare('UPDATE fomo_score_snapshots SET snapshot_sha256=?').run('d'.repeat(64));
  const record=JSON.parse(db.prepare('SELECT payload_json FROM fomo_price_evidence').get().payload_json);record.candles[0].open=999;
  db.prepare('UPDATE fomo_price_evidence SET payload_json=?').run(JSON.stringify(record));assert.throws(()=>exportOutcomeRows(db,{horizonHours:1}),/saved_evidence_hash_mismatch/);
 }finally{db.close();}
});

test('bounded CLI refuses database/output collisions and unsupported horizons',()=>{
 assert.throws(()=>parseOutcomeArgs(['--db','same','--output','same','--evidence-output','evidence']),/output_paths_must_be_distinct/);
 assert.throws(()=>parseOutcomeArgs(['--horizon-hours','500']),/invalid_horizon_hours/);
 assert.throws(()=>parseOutcomeArgs(['--output','labels']),/both_export_paths_required/);
 assert.throws(()=>parseOutcomeArgs(['--base-url','https://user:secret@example.test']),/invalid_base_url/);
 assert.equal(parseOutcomeArgs(['--status']).status,true);
 const db=fixture([]);ensureOutcomeSchema(db);db.close();
});
