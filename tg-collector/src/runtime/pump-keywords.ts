import {setTimeout as sleep} from "node:timers/promises";
import {alternativeTokenHistory,type TokenEvidence} from "./token-history.js";
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
export function tweetPumpTickers(texts:string[],limit:number):string[]{
 const counts=new Map<string,number>();const seen=new Set<string>();
 for(const text of texts){const normalized=text.trim().toLowerCase();if(seen.has(normalized))continue;seen.add(normalized);
  const tickers=new Set([...text.matchAll(/\$([a-z][a-z0-9_]{1,19})(?![a-z0-9_])/gi)].map(m=>m[1].toLowerCase()));
  for(const ticker of tickers)if(!['btc','eth','sol','usd','usdt','usdc','weth','wsol'].includes(ticker))counts.set(ticker,(counts.get(ticker)??0)+1);
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([ticker])=>ticker);
}
let primaryBlockedUntil=0;
export async function resolvePumpQuery(query:string,signal:AbortSignal):Promise<{tokens:TokenEvidence[];errorCode:string|null}> {
 if(Date.now()>primaryBlockedUntil){
  try{
   const url=mintPattern.test(query)?'https://frontend-api-v3.pump.fun/coins/'+encodeURIComponent(query):'https://frontend-api-v3.pump.fun/coins?offset=0&limit=5&sort=market_cap&order=DESC&includeNsfw=false&searchTerm='+encodeURIComponent(query.replace(/^\$/,''));
   const response=await fetch(url,{headers:{accept:'application/json','user-agent':'Mozilla/5.0 (compatible; TGCollector/1.0)'},signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
   if(response.status===403)primaryBlockedUntil=Date.now()+6*3600000;
   if(response.ok){
    const body:unknown=await response.json();const tokens:TokenEvidence[]=[];
    for(const value of (Array.isArray(body)?body.slice(0,5):[body])){
     const token=pumpToken(value,0);
     if(token&&(mintPattern.test(query)?token.mint===query:token.symbol.toLowerCase()===query.replace(/^\$/,'').toLowerCase()))
      tokens.push({...token,historicalPeakUsd:token.athUsd,evidenceType:'reported_ath',historyDays:null,peakAt:null,verifiedAt:new Date().toISOString()});
    }
    if(tokens.length)return {tokens,errorCode:null};
   }
  }catch{/* Public alternative is independent of Pump.fun transport. */}
 }
 try{return {tokens:await alternativeTokenHistory(query,fetch,signal),errorCode:null};}
 catch{return {tokens:[],errorCode:'HISTORY_PROVIDER_UNAVAILABLE'};}
}
export async function refreshPumpKeywords(settings:PumpSettings,words:string[],mints:string[]):Promise<string[]>{
 if(!settings.pump_enabled)return [];
 const {pool}=await import('../db.js');
 const queries=[...new Set([...settings.pump_queries,...mints,...words.filter(w=>/^[a-z][a-z0-9_]{1,19}$/i.test(w))])].slice(0,settings.pump_max_tokens);
 const tokens:TokenEvidence[]=[];let failures=0;const signal=AbortSignal.timeout(20000);
 for(const query of queries){
  if(signal.aborted)break;
  const key=mintPattern.test(query)?'mint:'+query:'ticker:'+query.toLowerCase();
  const cached=await pool.query<{result:{tokens:TokenEvidence[];errorCode:string|null}}>('SELECT result FROM tg_pump_history_cache WHERE query_key=$1 AND expires_at>now()',[key]);
  const result=cached.rows[0]?.result??await resolvePumpQuery(query,signal);
  if(!cached.rowCount)await pool.query(`INSERT INTO tg_pump_history_cache(query_key,result,expires_at) VALUES($1,$2::jsonb,now()+($3::int*interval '1 second'))
   ON CONFLICT(query_key) DO UPDATE SET result=EXCLUDED.result,expires_at=EXCLUDED.expires_at,updated_at=now()`,[key,JSON.stringify(result),result.errorCode?900:result.tokens.length?21600:3600]);
  if(result.errorCode)failures++;
  for(const token of result.tokens)if(token.historicalPeakUsd>=settings.pump_min_ath_usd&&!tokens.some(t=>t.mint===token.mint))tokens.push(token);
  await sleep(200);
 }
 await pool.query('UPDATE tg_discovery_settings SET pump_results=$2::jsonb,pump_error_code=$3 WHERE id=1 AND revision=$1',[settings.revision,JSON.stringify(tokens),failures?'HISTORY_PROVIDER_UNAVAILABLE':null]);
 return tokens.flatMap(t=>[t.mint,...(t.symbol?[t.symbol.toLowerCase()]:[])]);
}
