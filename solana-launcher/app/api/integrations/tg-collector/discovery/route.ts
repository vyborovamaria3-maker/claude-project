import {NextRequest,NextResponse} from "next/server";
import {Pool} from "pg";
import {guardTgCollector} from "@/lib/tgCollectorAccess";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const shared=globalThis as typeof globalThis & {__tgCollectorPool?:Pool};
function db(){
 if(!process.env.TG_COLLECTOR_DATABASE_URL)throw Error("Unavailable");
 return shared.__tgCollectorPool??=new Pool({connectionString:process.env.TG_COLLECTOR_DATABASE_URL,max:4,connectionTimeoutMillis:4000,idleTimeoutMillis:30000});
}
export async function GET(request:NextRequest){
 const denied=guardTgCollector(request);if(denied)return denied;
 try{
  const p=db();const [settings,today,candidates,total,mentionStats,mentions,searches,externalStats,externalQueue]=await Promise.all([
   p.query("SELECT * FROM tg_discovery_settings WHERE id=1"),
   p.query("SELECT queries,added FROM tg_discovery_daily WHERE day=(now() AT TIME ZONE 'UTC')::date"),
   p.query(`SELECT d.username,d.title,d.keyword,d.first_seen_at,d.connected_at,
    d.source_id IS NOT NULL AS connected,s.enabled FROM tg_discovered_sources d
    LEFT JOIN tg_sources s ON s.id=d.source_id ORDER BY d.last_seen_at DESC LIMIT 20`),
   p.query("SELECT count(*)::int AS found,count(*) FILTER(WHERE source_id IS NOT NULL)::int AS connected FROM tg_discovered_sources"),
   p.query(`SELECT count(*)::int AS mentions,count(DISTINCT peer_id)::int AS sources,
    count(*) FILTER(WHERE source_id IS NOT NULL)::int AS connected_mentions FROM tg_discovery_mentions`),
   p.query("SELECT m.username,m.title,m.message_id::text,m.text,m.posted_at,m.matched_terms,m.source_id::text,ARRAY(SELECT DISTINCT provider FROM tg_external_verified_posts e WHERE e.peer_id=m.peer_id AND e.message_id=m.message_id)AS external_providers FROM tg_discovery_mentions m ORDER BY m.first_seen_at DESC LIMIT 40"),
   p.query("SELECT query,reported_count,updated_at,last_error_code FROM tg_message_search_cursors ORDER BY updated_at DESC LIMIT 30"),
   p.query(`SELECT (SELECT count(DISTINCT(peer_id,message_id))::int FROM tg_external_verified_posts)AS mentions,
    (SELECT count(DISTINCT peer_id)::int FROM tg_external_verified_posts)AS sources,
    COALESCE((SELECT pages FROM tg_external_daily WHERE day=(now()AT TIME ZONE 'UTC')::date),0)AS pages_today`),
   p.query("SELECT username,origin,status,last_checked_at FROM tg_external_candidates ORDER BY last_checked_at DESC NULLS LAST LIMIT 20")]);
  return NextResponse.json({settings:settings.rows[0],today:today.rows[0]??{queries:0,added:0},candidates:candidates.rows,totals:total.rows[0],mentionStats:mentionStats.rows[0],mentions:mentions.rows,searches:searches.rows,externalStats:externalStats.rows[0],externalQueue:externalQueue.rows}, {headers});
 }catch{return NextResponse.json({error:"Автопоиск пока недоступен. Проверьте worker и миграции."},{status:503,headers});}
}
export async function POST(request:NextRequest){
 const denied=guardTgCollector(request,true);if(denied)return denied;
 try{
  const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader)while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
   if(size>8192){await reader.cancel();return NextResponse.json({error:"Слишком большой запрос"},{status:413,headers});}chunks.push(part.value);}
  const text=Buffer.concat(chunks).toString("utf8");
  let b:Record<string,unknown>;try{b=JSON.parse(text);}catch{return NextResponse.json({error:"Некорректный JSON"},{status:400,headers});}
  if(!b||typeof b!=="object"||Array.isArray(b))return NextResponse.json({error:"Некорректные настройки"},{status:400,headers});
  b.externalSearchEnabled??=false;b.externalSources??=["AscendEXEnglish", "AscendEXAnnoucement", "coinkolik", "cg_listingalert", "Dex_Trade", "OKX_Ukraine", "cryptonarratives1", "indodax", "Coin_Signals"];b.externalPagesPerCycle??=1;b.externalMaxPagesPerDay??=24;
  b.messageSearchEnabled??=false;b.messageTerms??=['PNUT','Peanut the Squirrel','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump'];
  b.pumpEnabled??=false;b.pumpMinAthUsd??=100000;b.pumpMaxTokens??=3;b.pumpQueries??=[];
  b.autoKeywordsEnabled??=true;b.autoKeywordsLimit??=12;b.twitterLookbackHours??=72;
  b.twitterTweetLimit??=2000;b.minKeywordPosts??=3;b.minKeywordAuthors??=2;
  const bounds:Record<string,[number,number]>={externalPagesPerCycle:[1,3],externalMaxPagesPerDay:[1,48],pumpMinAthUsd:[1000,1000000000],pumpMaxTokens:[1,10],intervalMinutes:[15,1440],resultsPerQuery:[1,50],queriesPerCycle:[1,10],maxQueriesPerDay:[1,200],maxNewPerDay:[1,100],maxSources:[1,1000],autoKeywordsLimit:[1,30],twitterLookbackHours:[1,168],twitterTweetLimit:[100,5000],minKeywordPosts:[2,20],minKeywordAuthors:[1,10]};
  if(typeof b.externalSearchEnabled!=='boolean'||!Array.isArray(b.externalSources)||b.externalSources.length<1||b.externalSources.length>50||b.externalSources.some(v=>typeof v!=='string'||!/^[a-z][a-z0-9_]{4,31}$/i.test(v))||typeof b.messageSearchEnabled!=='boolean'||!Array.isArray(b.messageTerms)||b.messageTerms.length<1||b.messageTerms.length>30||b.messageTerms.some(k=>typeof k!=='string'||k.trim().length<3||k.trim().length>64||/[\x00-\x1f]/.test(k))||typeof b.pumpEnabled!=='boolean'||!Array.isArray(b.pumpQueries)||b.pumpQueries.length>10||b.pumpQueries.some(q=>typeof q!=='string'||!/^[a-zA-Z0-9_\p{L}]{2,44}$/u.test(q))||typeof b.enabled!=="boolean"||typeof b.autoKeywordsEnabled!=="boolean"||!Array.isArray(b.keywords)||(!b.autoKeywordsEnabled&&b.keywords.length<1)||b.keywords.length>30||
   b.keywords.some(k=>typeof k!=="string"||k.trim().length<3||k.trim().length>64||/[\x00-\x1f]/.test(k))||
   Object.entries(bounds).some(([key,[min,max]])=>!Number.isInteger(b[key])||Number(b[key])<min||Number(b[key])>max))
   return NextResponse.json({error:"Проверьте ключевые слова и допустимые лимиты"},{status:400,headers});
  const keywords=[...new Set((b.keywords as string[]).map(k=>k.trim().toLowerCase()))];
  await db().query(`UPDATE tg_discovery_settings SET enabled=$1,keywords=$2,interval_minutes=$3,
   results_per_query=$4,queries_per_cycle=$5,max_queries_per_day=$6,max_new_per_day=$7,max_sources=$8,
   auto_keywords_enabled=$9,auto_keywords_limit=$10,twitter_lookback_hours=$11,twitter_tweet_limit=$12,
   min_keyword_posts=$13,min_keyword_authors=$14,pump_enabled=$15,pump_min_ath_usd=$16,pump_max_tokens=$17,pump_queries=$18,message_search_enabled=$19,message_terms=$20,external_search_enabled=$21,external_sources=$22,external_pages_per_cycle=$23,external_max_pages_per_day=$24,revision=revision+1,keyword_cursor=0,next_run_at=now(),last_error_code=NULL WHERE id=1`,
   [b.enabled,keywords,b.intervalMinutes,b.resultsPerQuery,b.queriesPerCycle,b.maxQueriesPerDay,b.maxNewPerDay,b.maxSources,b.autoKeywordsEnabled,b.autoKeywordsLimit,b.twitterLookbackHours,b.twitterTweetLimit,b.minKeywordPosts,b.minKeywordAuthors,b.pumpEnabled,b.pumpMinAthUsd,b.pumpMaxTokens,b.pumpQueries,b.messageSearchEnabled,[...new Set((b.messageTerms as string[]).map(k=>k.trim()))],b.externalSearchEnabled,b.externalSources,b.externalPagesPerCycle,b.externalMaxPagesPerDay]);
  return NextResponse.json({ok:true},{headers});
 }catch{return NextResponse.json({error:"Не удалось сохранить настройки автопоиска"},{status:503,headers});}
}
