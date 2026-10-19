export const mintPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export type TokenEvidence={mint:string;symbol:string;athUsd:number|null;historicalPeakUsd:number;
 provider:string;evidenceType:"reported_ath"|"historical_lower_bound";historyDays:number|null;peakAt:string|null;verifiedAt:string};
type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
export function historicalPeak(body:unknown,now=Date.now()):{value:number;timestamp:number}|null {
 const rows=(body as {market_caps?:unknown}|null)?.market_caps;
 if(!Array.isArray(rows))return null;
 let peak:{value:number;timestamp:number}|null=null;
 for(const row of rows){
  if(!Array.isArray(row)||row.length!==2)continue;
  const [timestamp,value]=row;
  // Completed historical days only; never use the current capitalization or an FDV estimate.
  if(typeof timestamp!=="number"||!Number.isFinite(timestamp)||timestamp<now-91*86400000||timestamp>now-86400000||
    typeof value!=="number"||!Number.isFinite(value)||value<=0)continue;
  if(!peak||value>peak.value)peak={value,timestamp};
 }
 return peak;
}
export async function alternativeTokenHistory(query:string,fetcher:Fetcher=fetch,signal?:AbortSignal):Promise<TokenEvidence[]> {
 const read=async(url:string):Promise<any>=>{
  const response=await fetcher(url,{headers:{accept:"application/json"},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
  if(response.status===404)return null;
  if(!response.ok)throw Error('HISTORY_PROVIDER_UNAVAILABLE');
  return response.json();
 };
 const requestedMint=mintPattern.test(query);
 let candidates:string[];
 if(requestedMint)candidates=[query];
 else{
  const body=await read('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(query.replace(/^\$/,'')));
  const pairs=Array.isArray(body?.pairs)?body.pairs:[];
  candidates=[...new Set<string>(pairs.filter((p:any)=>p?.chainId==='solana'&&typeof p.baseToken?.address==='string'&&mintPattern.test(p.baseToken.address)&&
   typeof p.baseToken?.symbol==='string'&&p.baseToken.symbol.trim().toLowerCase()===query.replace(/^\$/,'').toLowerCase())
   .sort((a:any,b:any)=>(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0)).map((p:any)=>p.baseToken.address))].slice(0,2);
 }
 const tokens:TokenEvidence[]=[];
 for(const mint of candidates){
  const info=await read('https://api.coingecko.com/api/v3/coins/solana/contract/'+encodeURIComponent(mint));
  // Exact contract mapping and provider category, not merely a mint ending in "pump".
  if(info?.platforms?.solana!==mint||typeof info.id!=='string'||typeof info.symbol!=='string'||
   !Array.isArray(info.categories)||!info.categories.some((c:unknown)=>typeof c==='string'&&/^pump\.?fun(?: ecosystem| memecoins)?$/i.test(c))||
   (!requestedMint&&info.symbol.trim().toLowerCase()!==query.replace(/^\$/,'').toLowerCase()))continue;
  const history=await read('https://api.coingecko.com/api/v3/coins/'+encodeURIComponent(info.id)+'/market_chart?vs_currency=usd&days=90&interval=daily');
  const peak=historicalPeak(history);if(!peak)continue;
  const symbol=info.symbol.trim();
  if(!/^[\p{L}\p{N}_]{2,24}$/u.test(symbol))continue;
  tokens.push({mint,symbol,athUsd:null,historicalPeakUsd:peak.value,provider:'coingecko',evidenceType:'historical_lower_bound',historyDays:90,peakAt:new Date(peak.timestamp).toISOString(),verifiedAt:new Date().toISOString()});
 }
 return tokens;
}
