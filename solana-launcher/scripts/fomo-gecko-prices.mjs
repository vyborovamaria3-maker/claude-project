import {createHash} from 'node:crypto';
import {normalizeCandles,restorePriceHistory} from './fomo-price-joiner.mjs';

const MINT=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ROOT='https://api.geckoterminal.com/api/v2/networks/solana';
const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';

export function createGeckoPriceFetcher({fetcher=fetch,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),minRequestIntervalMs=7000,poolCacheTtlMs=6*3600000}={}){
  const pools=new Map();
  let lastRequestAt=-Infinity,requestChain=Promise.resolve();
  function request(url){
    const task=requestChain.then(async()=>{
      const wait=Math.max(0,lastRequestAt+minRequestIntervalMs-clock());
      if(wait)await sleep(wait);
      lastRequestAt=clock();
      let response;
      try{response=await fetcher(url,{headers:{Accept:'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});}
      catch{throw Error('price_source_unavailable');}
      if(!response.ok)throw Error('price_source_unavailable');
      try{return await response.json();}catch{throw Error('invalid_price_response');}
    });
    requestChain=task.catch(()=>{});
    return task;
  }
  return async function fetchGeckoPriceHistory(_baseUrl,mint,timeframe,intervalSeconds){
    if(!MINT.test(mint))throw Error('invalid_price_mint');
    if(!['1m','5m'].includes(timeframe)||intervalSeconds!==(timeframe==='1m'?60:300))throw Error('invalid_timeframe');
    const poolLookupUrl=ROOT+'/tokens/'+mint+'/pools?page=1';
    let selection=pools.get(mint);
    if(!selection||clock()-selection.observedAt>poolCacheTtlMs){
      const response=await request(poolLookupUrl);
      if(!Array.isArray(response?.data))throw Error('invalid_price_response');
      const candidates=response.data.flatMap(pool=>{
        const address=pool?.attributes?.address;
        if(pool?.type!=='pool'||!MINT.test(address)||pool.id!=='solana_'+address)return [];
        const ids=['base','quote'].map(side=>pool.relationships?.[side+'_token']?.data);
        if(ids.some(item=>item?.type!=='token'||!item.id?.startsWith('solana_')||!MINT.test(item.id.slice(7))))return [];
        const index=ids.findIndex(item=>item.id==='solana_'+mint);
        if(index<0)return [];
        return [{pool:{id:pool.id,type:pool.type,attributes:{address},relationships:{base_token:{data:ids[0]},quote_token:{data:ids[1]}}},side:index===0?'base':'quote',liquidity:Number(pool.attributes.reserve_in_usd)||0}];
      }).sort((a,b)=>b.liquidity-a.liquidity||a.pool.id.localeCompare(b.pool.id));
      if(!candidates.length)throw Error('price_source_unavailable');
      selection={...candidates[0],observedAt:clock()};
      if(pools.size>=100)pools.delete(pools.keys().next().value);
      pools.set(mint,selection);
    }
    const address=selection.pool.attributes.address;
    const url=new URL(ROOT+'/pools/'+address+'/ohlcv/minute');
    for(const [key,value] of Object.entries({aggregate:intervalSeconds/60,limit:1000,currency:'usd',token:selection.side,include_empty_intervals:false}))url.searchParams.set(key,String(value));
    const payload=await request(url);
    const fetchedAtMs=clock();
    if(payload?.data?.type!=='ohlcv_request_response'||!Array.isArray(payload.data.attributes?.ohlcv_list))throw Error('invalid_price_response');
    for(const side of ['base','quote']){
      if(payload.meta?.[side]?.address!==selection.pool.relationships[side+'_token'].data.id.slice(7)){
        pools.delete(mint);throw Error('price_source_unavailable');
      }
    }
    const raw=payload.data.attributes.ohlcv_list.map(row=>{
      if(!Array.isArray(row)||row.length<6)throw Error('invalid_price_candle');
      const [time,open,high,low,close,volume]=row;
      return {time,open,high,low,close,volume};
    });
    const candles=normalizeCandles(raw,intervalSeconds,fetchedAtMs);
    const evidence={recordType:'price_evidence',schemaVersion:1,canonicalTokenId:'solana:'+mint,mint,source:'geckoterminal',priceUnit:'USD',poolAddress:address,mock:false,requestUrl:url.toString(),fetchedAt:new Date(fetchedAtMs).toISOString(),timeframe,intervalSeconds,candleCount:candles.length,candles,
      priceProvenance:{schemaVersion:1,network:'solana',currency:'usd',tokenSide:selection.side,includeEmptyIntervals:false,poolLookupUrl,poolObservedAt:new Date(selection.observedAt).toISOString(),pool:selection.pool,ohlcvMeta:payload.meta}};
    const evidenceSha256=createHash('sha256').update(stable(evidence)).digest('hex');
    return restorePriceHistory({...evidence,evidenceSha256});
  };
}

// One shared pacing/cache instance for all horizons and tokens in the worker.
export const fetchGeckoPriceHistory=createGeckoPriceFetcher();
