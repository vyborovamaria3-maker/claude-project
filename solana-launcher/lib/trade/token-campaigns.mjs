import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const MINT=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,HASH=/^[a-f0-9]{64}$/,HANDLE=/^[a-zA-Z0-9_]{1,15}$/;
const finite=(v,min=-1,max=1e15)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const hash=s=>createHash('sha256').update(s).digest('hex');
async function jsonFile(path,max=8*1024*1024){if((await stat(path)).size>max)throw Error('invalid_snapshot');const raw=await readFile(path);if(raw.length>max)throw Error('invalid_snapshot');return {raw,value:JSON.parse(raw.toString('utf8'))};}
export async function readCampaignEvidence(mint,sha,{directory=process.env.AUTHOR_OUTCOMES_DIRECTORY,now=Date.now()}={}){
 if(!directory||!MINT.test(mint)||!HASH.test(sha))throw Error('campaign_evidence_unavailable');
 const path=join(directory,'evidence','author-'+sha+'.json');const {raw,value:p}=await jsonFile(path);
 const checksum=(await readFile(path+'.sha256','utf8')).trim();
 if(!HASH.test(checksum)||hash(raw)!==checksum||p.version!==1||p.source!=='geckoterminal'||p.network!=='solana'||p.currency!=='usd'||p.mint!==mint||p.interval_ms!==300000||!finite(p.fetched_at,0,now)||!Array.isArray(p.candles)||p.candles.length>1000||!MINT.test(p.pool))throw Error('campaign_evidence_unavailable');
 if(!['base','quote'].includes(p.token_side)||p.ohlcv_meta?.[p.token_side]?.address!==mint||p.pool_record?.attributes?.address!==p.pool||p.pool_record?.id!=='solana_'+p.pool||p.pool_record?.type!=='pool')throw Error('campaign_evidence_unavailable');
 for(const side of ['base','quote'])if(!MINT.test(p.ohlcv_meta?.[side]?.address??'')||p.pool_record.relationships?.[side+'_token']?.data?.type!=='token'||p.pool_record.relationships?.[side+'_token']?.data?.id!=='solana_'+p.ohlcv_meta?.[side]?.address)throw Error('campaign_evidence_unavailable');
 if(typeof p.request_url!=='string'||!p.request_url.startsWith('https://api.geckoterminal.com/api/v2/networks/solana/pools/'+p.pool+'/ohlcv/minute?'))throw Error('campaign_evidence_unavailable');
 const request=new URL(p.request_url);if([...request.searchParams.keys()].some(k=>!['currency','token','aggregate','limit','include_empty_intervals','before_timestamp'].includes(k))||request.searchParams.get('currency')!=='usd'||request.searchParams.get('token')!==p.token_side||request.searchParams.get('aggregate')!=='5'||request.searchParams.get('include_empty_intervals')!=='false')throw Error('campaign_evidence_unavailable');
 let previous=-1;for(const c of p.candles){if(!Array.isArray(c)||c.length!==6||!c.every(n=>finite(n,0))||c[0]<=previous||c[0]%300000||c[0]+300000>p.fetched_at||Math.min(...c.slice(1,5))<=0||c[2]<Math.max(c[1],c[3],c[4])||c[3]>Math.min(c[1],c[2],c[4]))throw Error('campaign_evidence_unavailable');previous=c[0];}
 return {version:1,source:p.source,network:p.network,currency:p.currency,mint:p.mint,pool:p.pool,token_side:p.token_side,interval_ms:p.interval_ms,fetched_at:p.fetched_at,request_url:p.request_url,lookup_url:'https://api.geckoterminal.com/api/v2/networks/solana/tokens/'+mint+'/pools?page=1',pool_record:{id:p.pool_record.id,type:p.pool_record.type,attributes:{address:p.pool},relationships:Object.fromEntries(['base','quote'].map(side=>[side+'_token',{data:{id:p.pool_record.relationships[side+'_token'].data.id,type:'token'}}]))},ohlcv_meta:Object.fromEntries(['base','quote'].map(side=>[side,{address:p.ohlcv_meta[side].address}])),candles:p.candles.map(c=>[...c])};
}
function projectPrice(o,proof,postAt){
 if(!o||!finite(o.entry_at,postAt,postAt+300000)||!finite(o.exit_at,o.entry_at)||!finite(o.entry_usd,Number.MIN_VALUE)||!finite(o.exit_usd,Number.MIN_VALUE))return null;
 const a=proof.candles.find(c=>c[0]===o.entry_at),b=proof.candles.find(c=>c[0]===o.exit_at);if(!a||!b||a[1]!==o.entry_usd||b[1]!==o.exit_usd||a[5]<=0||b[5]<=0)return null;
 return {entryAt:a[0],exitAt:b[0],entryUsd:a[1],exitUsd:b[1],grossReturn:b[1]/a[1]-1,netReturn:b[1]*.99/(a[1]*1.01)-1,entryVolumeUsd:a[5],exitVolumeUsd:b[5],quality:Math.min(a[5],b[5])<100?'thin_candle':'observed_price'};
}
function projectPrior(raw,proof,postAt){
 if(!raw)return null;const a=proof.candles.find(c=>c[0]===raw.rise_from_at),b=proof.candles.find(c=>c[0]===raw.rise_to_at);
 if(!a||!b||a[0]>b[0]||b[0]+300000>postAt||a[0]<Math.floor(postAt/300000)*300000-86400000||Math.min(a[5],b[5])<=0)return null;
 return {fromAt:a[0],toAt:b[0],fromUsd:a[1],toUsd:b[1],gain:b[1]/a[1]-1,fromVolumeUsd:a[5],toVolumeUsd:b[5],quality:Math.min(a[5],b[5])<100?'thin_candle':'observed_price',complete24h:raw.complete_24h===true};
}
const unavailable=(mint,status)=>({version:'token-campaign-v1',mint,status,available:false});
/** Read-only, mint-scoped optional context; never invokes a provider or changes collector state. */
export async function readTokenCampaigns(mint,{directory=process.env.AUTHOR_OUTCOMES_DIRECTORY,now=Date.now(),maxAgeMs=900000}={}){
 if(!MINT.test(mint))throw Error('invalid_mint');if(!directory)return unavailable(mint,'not_configured');
 try{
  const [{value:t},{value:r}]=await Promise.all([jsonFile(join(directory,'timing.json')),jsonFile(join(directory,'recurring.json'))]);
  if(t.version!==1||r.version!==1||!Array.isArray(t.records)||!Array.isArray(r.ranked_groups)||!Array.isArray(r.pairs)||!Array.isArray(r.trios)||!finite(t.checked_at,0,now)||!finite(r.checked_at,0,now))return unavailable(mint,'invalid_snapshot');
  const generatedAt=Math.min(t.checked_at,r.checked_at);if(now-generatedAt>maxAgeMs)return {...unavailable(mint,'stale'),generatedAt};
  const groups=r.ranked_groups.filter(g=>g.mint===mint&&HASH.test(g.group_id)&&Array.isArray(g.authors)&&g.authors.every(a=>HANDLE.test(a))).map(g=>({id:g.group_id,authors:g.authors.slice(0,20),spanSeconds:finite(g.span_seconds,0,900)?g.span_seconds:null,tokenConfirmed:g.token_confirmed===true,maximumRepeatedPairCa:finite(g.maximum_repeated_pair_ca,0,100000)?g.maximum_repeated_pair_ca:0}));
  const related=rows=>rows.filter(c=>Array.isArray(c.tokens)&&c.tokens.some(x=>x.mint===mint)&&Array.isArray(c.authors)&&c.authors.every(a=>HANDLE.test(a))&&finite(c.distinct_ca,2,100000)).map(c=>({authors:c.authors.slice(0,3),distinctCa:c.distinct_ca,utcDays:finite(c.utc_days,0,100000)?c.utc_days:0}));
  const rawRecords=t.records.filter(p=>p.mint===mint&&HANDLE.test(p.author)&&/^\d{1,30}$/.test(p.tweet_id)&&finite(p.posted_at,0,now)&&typeof p.source_text==='string'&&HASH.test(p.source_hash)&&hash(p.source_text)===p.source_hash);
  const proofs=new Map(),records=[];
  for(const p of rawRecords){let proof=null;if(HASH.test(p.evidence_hash??'')){if(!proofs.has(p.evidence_hash))proofs.set(p.evidence_hash,await readCampaignEvidence(mint,p.evidence_hash,{directory,now}).catch(()=>null));proof=proofs.get(p.evidence_hash);}
   const outcomes={};let prior=null;if(proof){for(const h of [1,24,72]){const o=projectPrice(p.outcomes?.[h],proof,p.posted_at);if(o&&o.exitAt>=o.entryAt+h*3600000&&o.exitAt<=o.entryAt+h*3600000+300000)outcomes[h]=o;}prior=projectPrior(p.observed_prior_24h,proof,p.posted_at);}
   // Recompute the decisive past-jump label from verified price anchors.
   let phase='insufficient_history';
   if(proof){const floor=Math.floor(p.posted_at/300000)*300000,points=new Map(proof.candles.map(c=>[c[0],c]));const hour=Array.from({length:12},(_,i)=>points.get(floor-3600000+i*300000));const complete=hour.every(c=>c&&c[5]>0);const peak=complete?hour.reduce((a,b)=>a[2]>b[2]?a:b):null;const preJump=complete&&hour[0][5]>=100&&peak[5]>=100&&peak[2]/hour[0][1]-1>=.5;const growth=Object.values(outcomes).some(o=>o.quality==='observed_price'&&o.grossReturn>=.5);const goodHour=complete&&hour.every(c=>c[5]>=100);
    if((prior?.quality==='observed_price'&&prior.gain>=.5)||preJump)phase='after_prior_jump';else if(goodHour&&growth)phase='before_later_growth';else if(growth)phase='later_growth_prior_unknown';else if(goodHour&&Object.values(outcomes).some(o=>o.quality==='observed_price'))phase='no_50pct_event';
   }
   records.push({tweetId:p.tweet_id,author:p.author,postedAt:p.posted_at,text:p.source_text.slice(0,360),textTruncated:p.source_text.length>360,textHash:p.source_hash,firstStoredMention:p.first_stored_mention===true,earlierContext:p.scope==='earlier_context',phase,prior,outcomes,evidenceHash:proof?p.evidence_hash:null});
  }
  const counts={groups:groups.length,recurringPairs:related(r.pairs).length,recurringTrios:related(r.trios).length,posts:records.length,pricedPosts:records.filter(p=>Object.keys(p.outcomes).length).length,afterPriorJump:records.filter(p=>p.phase==='after_prior_jump').length,beforeLaterGrowth:records.filter(p=>p.phase==='before_later_growth').length,thinQuotes:records.reduce((n,p)=>n+Object.values(p.outcomes).filter(o=>o.quality==='thin_candle').length,0)};
  records.sort((a,b)=>Number(b.firstStoredMention)-Number(a.firstStoredMention)||Number(Boolean(b.prior))-Number(Boolean(a.prior))||a.postedAt-b.postedAt||a.tweetId.localeCompare(b.tweetId));
  const out={version:'token-campaign-v1',mint,status:'available',available:true,generatedAt,counts,groups:groups.slice(0,10),pairs:related(r.pairs).slice(0,10),trios:related(r.trios).slice(0,10),records:records.slice(0,12),limitations:['Только точный CA; похожие тексты и близкое время не доказывают оплату или общего владельца.','Проверены первые сохранённые посты участников, включая публикации вне группового окна; архив может быть неполным.','Рост до поста относится к наблюдаемому отрезку, а не глобальному максимуму. Тонкие свечи не подтверждают исполнимую доходность.','Результаты ретроспективные, с условными издержками 1% на каждой стороне; это не PNL авторов.']};
  while(Buffer.byteLength(JSON.stringify(out))>24000&&out.records.length)out.records.pop();return out;
 }catch{return unavailable(mint,'unavailable');}
}
export function campaignFacts(c){return c?.available?{'campaign.groups':c.counts.groups,'campaign.recurringPairs':c.counts.recurringPairs,'campaign.afterPriorJump':c.counts.afterPriorJump,'campaign.thinQuotes':c.counts.thinQuotes}:{};}
export function campaignModelContext(c){return c?.available?{mint:c.mint,generatedAt:c.generatedAt,counts:c.counts,limitations:c.limitations}:undefined;}
