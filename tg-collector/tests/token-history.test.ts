import {test} from "node:test";
import assert from "node:assert/strict";
import {alternativeTokenHistory,historicalPeak} from "../src/runtime/token-history.js";
const mint='2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump';
const now=Date.now();
const info={id:'peanut-the-squirrel',symbol:'pnut',platforms:{solana:mint},categories:['Pump.fun Ecosystem']};
const chart={market_caps:[[now-2*86400000,200000],[now-864000,900000000]]};
function mock(metadata=info,history:unknown=chart){
 const calls:string[]=[];
 const fetcher=async(url:string)=>{calls.push(url);return new Response(JSON.stringify(url.includes('dexscreener')?{pairs:[
  {chainId:'ethereum',baseToken:{address:mint,symbol:'PNUT'},liquidity:{usd:999999}},
  {chainId:'solana',baseToken:{address:mint,symbol:'Pnut '},liquidity:{usd:1000}},
  {chainId:'solana',baseToken:{address:mint,symbol:'PNUTFAKE'},liquidity:{usd:99999}}]}:url.includes('market_chart')?history:metadata));};
 return {calls,fetcher};
}
test('historical cap excludes current, FDV, stale, future, malformed and nonfinite values',()=>{
 assert.equal(historicalPeak(chart,now)?.value,200000);
 assert.equal(historicalPeak({market_caps:[[now-1000,999999999]],market_cap:999999999,fdv:999999999},now),null);
 assert.equal(historicalPeak({market_caps:[[now+1000,1e9],[now-100*86400000,1e9],[now-2*86400000,Infinity],['bad',1e9]]},now),null);
});
test('ticker resolves only exact Solana symbol and verified Pump contract then records bounded historical evidence',async()=>{
 const m=mock();const rows=await alternativeTokenHistory('PNUT',m.fetcher);
 assert.equal(rows.length,1);assert.equal(rows[0].mint,mint);assert.equal(rows[0].athUsd,null);
 assert.equal(rows[0].historicalPeakUsd,200000);assert.equal(rows[0].evidenceType,'historical_lower_bound');assert.equal(rows[0].historyDays,90);assert.equal(m.calls.length,3);
 const direct=mock();assert.equal((await alternativeTokenHistory(mint,direct.fetcher))[0].mint,mint);assert.equal(direct.calls.length,2);
});
test('fake suffix, wrong contract, missing history and provider errors never qualify',async()=>{
 for(const metadata of [{...info,categories:['Meme']},{...info,platforms:{solana:'different'}},{...info,symbol:'OTHER'}]){
  const m=mock(metadata);assert.deepEqual(await alternativeTokenHistory('PNUT',m.fetcher),[]);assert.equal(m.calls.length,2);
 }
 assert.deepEqual(await alternativeTokenHistory(mint,mock(info,{market_caps:[]}).fetcher),[]);
 await assert.rejects(alternativeTokenHistory(mint,async()=>new Response('{}',{status:429})),/HISTORY_PROVIDER_UNAVAILABLE/);
});

test('Pump 403 uses independent history and backs off the blocked primary',async()=>{
 const {resolvePumpQuery}=await import('../src/runtime/pump-keywords.js');
 const original=globalThis.fetch;const m=mock();let primaryCalls=0;
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes('pump.fun')){primaryCalls++;return new Response('blocked',{status:403});}return m.fetcher(url);};
 try{
  for(let i=0;i<2;i++){const result=await resolvePumpQuery('PNUT',AbortSignal.timeout(2000));assert.equal(result.errorCode,null);assert.equal(result.tokens[0].historicalPeakUsd,200000);}
  assert.equal(primaryCalls,1);
 }finally{globalThis.fetch=original;}
});

test('automatic token queries use cashtags rather than generic crypto topics',async()=>{
 const {tweetPumpTickers}=await import('../src/runtime/pump-keywords.js');
 assert.deepEqual(tweetPumpTickers(['solana memecoin $BTC $SOL $PNUT','another $PNUT $WIF','another $PNUT $WIF','buy $BONK'],2),['pnut','bonk']);
});
