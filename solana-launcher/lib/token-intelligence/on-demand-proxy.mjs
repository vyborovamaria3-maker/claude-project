import {assertMintShape,validateProxyConfiguration,SafeProxyError} from './proxy-core.mjs';
export function tokenSummary(report){
 const stance={bullish:'В выбранных сообщениях выражено позитивное отношение к токену.',bearish:'В выбранных сообщениях выражено негативное отношение к токену.',neutral:'В выбранных сообщениях нет выраженного направления.',mixed:'Направление сообщений неоднозначно.',unknown:'Недостаточно сообщений для оценки тона.'}[report.interpretation?.stance]??'Недостаточно сообщений для оценки тона.';
 return [stance,`Выборка: Telegram — ${report.facts['tg.sampledMessages']??0}, Twitter — ${report.facts['x.sampledMessages']??0}; сохранённых записей сделок — ${report.facts['chain.sampledStoredTradeRows']??0}.`,
  'Покрытие источников неполное; записи сделок сами по себе не подтверждают прибыльность.'].join('\n');
}
/** Server-side only. User auth/rate limiting is required before this call. */
export async function requestTokenAnalysis(mint,{env=process.env,fetchImpl=fetch}={}){
 assertMintShape(mint);const {token,port}=validateProxyConfiguration(env);
 try{
  const response=await fetchImpl('http://127.0.0.1:'+port+'/api/intelligence/v1/tokens/'+encodeURIComponent('solana:'+mint)+'/analyze',{
   method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(110000)});
  if(!response.ok)throw new SafeProxyError('token_analysis_unavailable',503);
  const reader=response.body?.getReader();if(!reader)throw new SafeProxyError('token_analysis_invalid',502);
  let size=0,body='';const decoder=new TextDecoder();try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw new SafeProxyError('token_analysis_invalid',502);body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}finally{await reader.cancel();reader.releaseLock();}
  const report=JSON.parse(body);
  if(report.version!=='token-request-v1'||report.tokenId!=='solana:'+mint||!['analyzed','no_evidence'].includes(report.status)||!Array.isArray(report.summary)||!report.facts||report.summary.some(row=>!Object.hasOwn(report.facts,row.id)||row.value!==report.facts[row.id]))throw new SafeProxyError('token_analysis_invalid',502);
  // Explicit projection: no upstream keys, trace IDs or arbitrary provider prose.
  return {agent:'api',available:report.status==='analyzed',analysisMode:'token_on_demand',
   result:{summary:tokenSummary(report),overallConfidence:report.interpretation?.confidence??0},
   tokenAnalysis:{version:report.version,tokenId:report.tokenId,asOf:report.asOf,status:report.status,cached:report.cached===true,
    facts:report.facts,summary:report.summary,interpretation:report.interpretation,sourceStatus:report.sourceStatus,grounding:report.grounding,evidence:report.evidence}};
 }catch(error){if(error instanceof SafeProxyError)throw error;throw new SafeProxyError('token_analysis_unavailable',503);}
}
