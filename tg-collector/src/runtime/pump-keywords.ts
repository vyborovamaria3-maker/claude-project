import {setTimeout as sleep} from "node:timers/promises";
export type PumpSettings={pump_enabled:boolean;pump_min_ath_usd:number;pump_max_tokens:number;pump_queries:string[];revision:number};
const mintPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function pumpToken(value:unknown,minAth:number){
 const c=value as Record<string,unknown>|null;
 if(!c||typeof c.mint!=="string"||!mintPattern.test(c.mint)||typeof c.symbol!=="string")return null;
 // Provider-reported historical USD market capitalization; current market cap is never a substitute.
 const ath=typeof c.ath_market_cap==='number'?c.ath_market_cap:null;
 if(ath===null||!Number.isFinite(ath)||ath<minAth)return null;
 const symbol=c.symbol.replace(/^\$/,'').trim();
 return {mint:c.mint,symbol:/^[\p{L}\p{N}_]{2,24}$/u.test(symbol)?symbol:'',athUsd:ath,provider:'pump.fun'};
}
export function tweetPumpMints(texts:string[],limit:number){
 const counts=new Map<string,number>();
 for(const text of texts){for(const mint of new Set(text.match(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{28,40}pump(?![1-9A-HJ-NP-Za-km-z])/g)??[]))counts.set(mint,(counts.get(mint)??0)+1);}
 return [...counts].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([mint])=>mint);
}
export async function refreshPumpKeywords(settings:PumpSettings,words:string[],mints:string[]):Promise<string[]>{
 if(!settings.pump_enabled)return [];
 const {pool}=await import('../db.js');
 const queries=[...new Set([...settings.pump_queries,...mints,...words.filter(w=>/^[a-z][a-z0-9_]{1,19}$/i.test(w))])].slice(0,settings.pump_max_tokens);
 const tokens:NonNullable<ReturnType<typeof pumpToken>>[]=[];let failures=0;
 for(const query of queries){
  try{
   const url=mintPattern.test(query)?'https://frontend-api-v3.pump.fun/coins/'+encodeURIComponent(query):'https://frontend-api-v3.pump.fun/coins?offset=0&limit=5&sort=market_cap&order=DESC&includeNsfw=false&searchTerm='+encodeURIComponent(query.replace(/^\$/,''));
   const response=await fetch(url,{headers:{accept:'application/json','user-agent':'Mozilla/5.0 (compatible; TGCollector/1.0)'},signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw Error('Unavailable');
   const body:unknown=await response.json();
   for(const value of (Array.isArray(body)?body.slice(0,5):[body])){
    const token=pumpToken(value,settings.pump_min_ath_usd);
    if(token&&(!mintPattern.test(query)||token.mint===query)&&!tokens.some(t=>t.mint===token.mint))tokens.push(token);
   }
  }catch{failures++;}
  await sleep(200);
 }
 await pool.query('UPDATE tg_discovery_settings SET pump_results=$2::jsonb,pump_error_code=$3 WHERE id=1 AND revision=$1',[settings.revision,JSON.stringify(tokens),failures?'PUMP_PROVIDER_UNAVAILABLE':null]);
 return tokens.flatMap(t=>[t.mint,...(t.symbol?[t.symbol.toLowerCase()]:[])]);
}
