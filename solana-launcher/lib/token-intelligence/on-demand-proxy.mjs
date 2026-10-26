import {assertMintShape,validateProxyConfiguration,SafeProxyError} from './proxy-core.mjs';
const VERSION='token-request-v1';
const COUNT_LIMITS={'x.sampledMessages':4,'tg.sampledMessages':4,'tg.filteredTemplates':96,
 'chain.sampledStoredTradeRows':100,'chain.sampledWallets':100};
function invalid(){throw new SafeProxyError('token_analysis_invalid',502);}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value;}
function utc(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))invalid();
 const date=new Date(value);if(!Number.isFinite(date.getTime()))invalid();
 const normalized=value.includes('.')?value.replace(/\.(\d{1,3})Z$/,(_,ms)=>'.'+ms.padEnd(3,'0')+'Z'):value.replace(/Z$/,'.000Z');
 if(date.toISOString()!==normalized)invalid();return normalized;
}
function ref(value,source){
 const pattern=source==='x'?/^x:tweet:[1-9]\d{0,29}$/:/^tg:message:-?[1-9]\d{0,29}:[1-9]\d{0,29}$/;
 if(typeof value!=='string'||!pattern.test(value))invalid();return value;
}
function hash(value){if(typeof value!=='string'||!/[a-f0-9]{64}/.test(value)||value.length!==64)invalid();return value;}
/** Every nested browser-visible field is projected independently of the upstream schema. */
export function projectTokenAnalysis(report,tokenId){
 object(report);
 if(report.version!==VERSION||report.tokenId!==tokenId||!['analyzed','no_evidence'].includes(report.status))invalid();
 const asOf=utc(report.asOf),input=object(report.facts),facts={tokenId};
 if(input.tokenId!==tokenId)invalid();
 for(const [key,max] of Object.entries(COUNT_LIMITS)){
  const value=input[key];if(!Number.isSafeInteger(value)||value<0||value>max)invalid();facts[key]=value;
 }
 for(const key of ['x.filteredTemplates','x.duplicateMessages']){
  const value=input[key]===undefined?0:input[key];
  if(!Number.isSafeInteger(value)||value<0||value>96)invalid();facts[key]=value;
 }
 if(input['chain.coverage']!=='unknown'||input['social.coverage']!=='unknown'||
   input['identity.method']!=='literal-address-match; stored-trade-mint')invalid();
 Object.assign(facts,{'chain.coverage':'unknown','social.coverage':'unknown',
  'identity.method':'literal-address-match; stored-trade-mint'});
 if(facts['chain.sampledWallets']>facts['chain.sampledStoredTradeRows'])invalid();
 if(!Array.isArray(report.summary)||report.summary.length>12)invalid();
 const summary=report.summary.map(row=>{
  object(row);if(typeof row.id!=='string'||!Object.hasOwn(facts,row.id)||row.value!==facts[row.id])invalid();
  return {id:row.id,value:facts[row.id]};
 });
 if(!Array.isArray(report.evidence)||report.evidence.length>8)invalid();
 const evidence=report.evidence.map(row=>{
  object(row);if(!['x','tg'].includes(row.source))invalid();
  const evidenceRef=ref(row.evidenceRef,row.source),observedAt=utc(row.observedAt);
  if(observedAt>asOf||!Array.isArray(row.contextEvidence)||row.contextEvidence.length>2)invalid();
  return {source:row.source,evidenceRef,textHash:hash(row.textHash),observedAt,
   contextEvidence:row.contextEvidence.map(context=>{
    object(context);const evidenceRef=ref(context.evidenceRef,row.source);
    if(row.source!=='tg'||!evidenceRef.startsWith(row.evidenceRef.split(':').slice(0,3).join(':')+':'))invalid();
    return {evidenceRef,textHash:hash(context.textHash)};
   })};
 });
 let interpretation=null;
 if(report.interpretation!==null){
  const value=object(report.interpretation);
  if(!['bullish','bearish','neutral','mixed','unknown'].includes(value.stance)||
   typeof value.directionAmbiguous!=='boolean'||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1||
   !Number.isFinite(value.score)||value.score< -1||value.score>1||
   !Array.isArray(value.factIds)||value.factIds.length<1||value.factIds.length>12||
   value.factIds.some(id=>typeof id!=='string'||!Object.hasOwn(facts,id))||
   !Array.isArray(value.evidenceRefs)||value.evidenceRefs.length>12)invalid();
  const allowed=new Set(evidence.map(row=>row.evidenceRef));
  const evidenceRefs=value.evidenceRefs.map(id=>{
   if(typeof id!=='string'||(!allowed.has(id)&&!/^chain:stored-trade:[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(id)))invalid();return id;
  });
  interpretation={stance:value.stance,score:value.score,confidence:value.confidence,
   directionAmbiguous:value.directionAmbiguous,factIds:[...value.factIds],evidenceRefs};
  if(value.caveats!==undefined){
   if(!Array.isArray(value.caveats)||value.caveats.length>4)invalid();
   interpretation.caveats=value.caveats.map(row=>{
    object(row);if(!allowed.has(row.evidenceRef)||!evidenceRefs.includes(row.evidenceRef)||typeof row.quote!=='string'||row.quote.trim().length<3||row.quote.length>240)invalid();
    return {evidenceRef:row.evidenceRef,quote:row.quote};
   });
  }
 }
 if((report.status==='no_evidence')!==(interpretation===null))invalid();
 const sourceStatus={};
 for(const source of ['x','tg','blockchain']){
  const value=object(object(report.sourceStatus)[source]);
  if(value.queried!==true||typeof value.truncated!=='boolean')invalid();
  sourceStatus[source]={queried:true,truncated:value.truncated};
  if(source==='blockchain'){
   if(value.kind!=='stored-trade-records-not-verified-settlement')invalid();
   sourceStatus[source].kind=value.kind;
  }
 }
 const grounding=object(report.grounding);
 if(grounding.version!==VERSION||grounding.selectedFactsVerified!==true||
  grounding.stance!=='model-classification-not-fact'||grounding.coverage!=='unknown')invalid();
 return {version:VERSION,tokenId,asOf,status:report.status,cached:report.cached===true,facts,summary,
  interpretation,sourceStatus,evidence,grounding:{version:VERSION,selectedFactsVerified:true,
   stance:'model-classification-not-fact',coverage:'unknown'}};
}
async function readJson(stream,maxBytes){
 const reader=stream?.getReader();if(!reader)throw new SafeProxyError('invalid_json',400);
 const chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>maxBytes)throw new SafeProxyError('request_too_large',413);chunks.push(value);}
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{throw new SafeProxyError('invalid_json',400);}
}
export async function readTokenAnalysisRequest(request){
 if(Number(request.headers.get('content-length'))>65536)throw new SafeProxyError('request_too_large',413);
 const body=await readJson(request.body,65536);
 if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.mint!=='string')
  throw new SafeProxyError('invalid_mint',400);
 return {mint:assertMintShape(body.mint.trim())};
}
export function tokenSummary(report){
 const stance={bullish:'В выбранных сообщениях выражено позитивное отношение к токену.',bearish:'В выбранных сообщениях выражено негативное отношение к токену.',neutral:'В выбранных сообщениях нет выраженного направления.',mixed:'Направление сообщений неоднозначно.',unknown:'Недостаточно сообщений для оценки тона.'}[report.interpretation?.stance]??'Недостаточно сообщений для оценки тона.';
 return [stance,`Выборка: Telegram — ${report.facts['tg.sampledMessages']??0}, Twitter — ${report.facts['x.sampledMessages']??0}; сохранённых записей сделок — ${report.facts['chain.sampledStoredTradeRows']??0}.`,
  ...(report.interpretation?.caveats?.length?['Оговорки авторов (цитаты из сообщений, не проверенные факты):',...report.interpretation.caveats.map(row=>`«${row.quote}» — ${row.evidenceRef}`)]:['Отдельные оговорки не выделены; это не подтверждает отсутствие рисков.']),
  ...((report.facts['tg.filteredTemplates']??0)+(report.facts['x.filteredTemplates']??0)+(report.facts['x.duplicateMessages']??0)>0?
   [`Исключено: рекламных и шаблонных сообщений Telegram — ${report.facts['tg.filteredTemplates']??0}, Twitter — ${report.facts['x.filteredTemplates']??0}; повторов Twitter — ${report.facts['x.duplicateMessages']??0}.`]:[]),
  ...(report.status==='no_evidence'?['После фильтрации данных для анализа не осталось. ИИ не вызывался.']:[]),
  'Оценка относится к тону сообщений; это не торговый сигнал.',
  'В ограниченной выборке сохраняются предупреждения; соотношение мнений по всем сообщениям не оценивалось.',
  'Покрытие источников неполное; записи сделок сами по себе не подтверждают прибыльность.'].join('\n');
}
/** Server-side only. User auth/rate limiting is required before this call. */
export async function requestTokenAnalysis(mint,{env=process.env,fetchImpl=fetch}={}){
 assertMintShape(mint);const {token,port}=validateProxyConfiguration(env);
 try{
  const response=await fetchImpl('http://127.0.0.1:'+port+'/api/intelligence/v1/tokens/'+encodeURIComponent('solana:'+mint)+'/analyze',{
   method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(110000)});
  if(!response.ok)throw new SafeProxyError('token_analysis_unavailable',503);
  let report;
  try{report=projectTokenAnalysis(await readJson(response.body,65536),'solana:'+mint);}
  catch{throw new SafeProxyError('token_analysis_invalid',502);}
  // Explicit projection: no upstream keys, trace IDs or arbitrary provider prose.
  return {agent:'api',available:report.status==='analyzed',analysisMode:'token_on_demand',
   result:{summary:tokenSummary(report),overallConfidence:report.interpretation?.confidence??0},
   tokenAnalysis:{version:report.version,tokenId:report.tokenId,asOf:report.asOf,status:report.status,cached:report.cached===true,
    facts:report.facts,summary:report.summary,interpretation:report.interpretation,sourceStatus:report.sourceStatus,grounding:report.grounding,evidence:report.evidence}};
 }catch(error){if(error instanceof SafeProxyError)throw error;throw new SafeProxyError('token_analysis_unavailable',503);}
}
