import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createGeckoPriceFetcher} from './fomo-gecko-prices.mjs';
import {calculateOutcomeLabel,restorePriceHistory} from './fomo-price-joiner.mjs';

const MINT='So11111111111111111111111111111111111111112';
const OTHER='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL='Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const START=Date.parse('2026-10-20T00:00:00Z');
const NOW=START+2*3600000;
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
function rehash(record){const {evidenceSha256,...base}=record;return {...base,evidenceSha256:createHash('sha256').update(stable(base)).digest('hex')};}
function pool(side='base',liquidity=100){
  return {id:'solana_'+POOL,type:'pool',attributes:{address:POOL,reserve_in_usd:String(liquidity)},relationships:{base_token:{data:{id:'solana_'+(side==='base'?MINT:OTHER),type:'token'}},quote_token:{data:{id:'solana_'+(side==='quote'?MINT:OTHER),type:'token'}}}};
}
function prices(side='base',{gap=false,badMeta=false}={}){
  const rows=Array.from({length:25},(_,i)=>[START/1000+i*300,1,1.2,0.9,1.1,100]).filter((_,i)=>!gap||i!==4);
  return {data:{type:'ohlcv_request_response',attributes:{ohlcv_list:rows.reverse()}},meta:{base:{address:side==='base'?MINT:OTHER},quote:{address:badMeta?POOL:side==='quote'?MINT:OTHER}}};
}
function harness({side='base',gap=false,badMeta=false,httpFailure=false,poolRows=[pool(side)]}={}){
  let now=NOW;const calls=[];
  const fetchHistory=createGeckoPriceFetcher({clock:()=>now,sleep:async ms=>{now+=ms;},fetcher:async(url,options)=>{
    calls.push({url:new URL(url),at:now,options});
    return {ok:!httpFailure,json:async()=>String(url).includes('/tokens/')?{data:poolRows}:prices(side,{gap,badMeta})};
  }});
  return {fetchHistory,calls};
}
function snapshot(){return {snapshotId:'a',canonicalTokenId:'solana:'+MINT,mint:MINT,scoreVersion:'v1',signalAt:new Date(START).toISOString(),maxInputObservedAt:new Date(START).toISOString(),fomoPressure:80,fomoQuality:60,qualityCoverage:0.5,signalCoverage:{x:'partial',tg:'partial',knownAt:new Date(START).toISOString()}};}

test('uses explicit USD base token candles, validates provider metadata and seals proof',async()=>{
  const {fetchHistory,calls}=harness();
  const history=await fetchHistory('http://ignored.invalid',MINT,'5m',300);
  assert.equal(calls.length,2);
  assert.equal(calls[1].url.hostname,'api.geckoterminal.com');
  assert.equal(calls[1].url.searchParams.get('currency'),'usd');
  assert.equal(calls[1].url.searchParams.get('token'),'base');
  assert.equal(calls[1].url.searchParams.get('aggregate'),'5');
  assert.equal(calls[1].url.searchParams.get('include_empty_intervals'),'false');
  assert.equal(calls[1].options.redirect,'error');
  assert.ok(calls[1].options.signal instanceof AbortSignal);
  assert.equal(history.priceUnit,'USD');
  assert.equal(history.candles.length,25);
  assert.equal(restorePriceHistory(history.evidenceRecord).evidenceRef,history.evidenceRef);
  assert.equal(calculateOutcomeLabel(snapshot(),history,{horizonHours:1,cutoffAtMs:NOW+60000}).status,'labelled');
});

test('selects quote-side OHLCV when the requested mint is the quote token',async()=>{
  const {fetchHistory,calls}=harness({side:'quote'});
  const history=await fetchHistory('',MINT,'5m',300);
  assert.equal(calls[1].url.searchParams.get('token'),'quote');
  assert.equal(history.priceProvenance.tokenSide,'quote');
  assert.equal(history.priceProvenance.ohlcvMeta.quote.address,MINT);
});

test('ignores pools of a different token even if their liquidity is higher',async()=>{
  const alien=pool();alien.relationships.base_token.data.id='solana_'+POOL;alien.attributes.reserve_in_usd='999999';
  const {fetchHistory}=harness({poolRows:[alien,pool()]});
  const history=await fetchHistory('',MINT,'5m',300);
  assert.equal(history.priceProvenance.ohlcvMeta.base.address,MINT);
});

test('paces all provider requests and reuses validated pool selection',async()=>{
  const {fetchHistory,calls}=harness();
  await fetchHistory('',MINT,'5m',300);await fetchHistory('',MINT,'1m',60);
  assert.equal(calls.length,3);
  assert.equal(calls[1].at-calls[0].at,7000);
  assert.equal(calls[2].at-calls[1].at,7000);
  assert.equal(calls[2].url.searchParams.get('aggregate'),'1');
});

test('does not fill gaps and excludes incomplete price coverage',async()=>{
  const {fetchHistory}=harness({gap:true});
  const history=await fetchHistory('',MINT,'5m',300);
  assert.equal(history.candles.length,24);
  assert.equal(calculateOutcomeLabel(snapshot(),history,{horizonHours:1,cutoffAtMs:NOW+60000}).reason,'price_gap_detected');
});

test('fails closed on token mismatch, rate limits and invalid intervals',async()=>{
  await assert.rejects(harness({badMeta:true}).fetchHistory('',MINT,'5m',300),/price_source_unavailable/);
  await assert.rejects(harness({httpFailure:true}).fetchHistory('',MINT,'5m',300),/price_source_unavailable/);
  await assert.rejects(harness().fetchHistory('',MINT,'5m',60),/invalid_timeframe/);
});

test('rejects generic Gecko data and tampered or incorrectly oriented provenance',async()=>{
  const {fetchHistory}=harness();const history=await fetchHistory('',MINT,'5m',300);
  const options={horizonHours:1,cutoffAtMs:NOW+60000};
  assert.equal(calculateOutcomeLabel(snapshot(),{...history,evidenceRecord:undefined},options).reason,'unsupported_price_source');
  const modified=structuredClone(history.evidenceRecord);modified.candles[0].open=100;
  assert.throws(()=>restorePriceHistory(modified),/saved_evidence_hash_mismatch/);
  const wrongSide=structuredClone(history.evidenceRecord);wrongSide.priceProvenance.tokenSide='quote';
  assert.throws(()=>restorePriceHistory(rehash(wrongSide)),/invalid_gecko_price_provenance/);
  const wrongUnit=structuredClone(history.evidenceRecord);wrongUnit.priceUnit='SOL';
  assert.throws(()=>restorePriceHistory(rehash(wrongUnit)),/invalid_gecko_price_provenance/);
  const wrongHost=structuredClone(history.evidenceRecord);wrongHost.requestUrl=wrongHost.requestUrl.replace('api.geckoterminal.com','unverified.invalid');
  assert.throws(()=>restorePriceHistory(rehash(wrongHost)),/invalid_gecko_price_provenance/);
});
