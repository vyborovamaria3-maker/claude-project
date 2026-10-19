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
  const p=db();const [settings,today,candidates,total]=await Promise.all([
   p.query("SELECT * FROM tg_discovery_settings WHERE id=1"),
   p.query("SELECT queries,added FROM tg_discovery_daily WHERE day=(now() AT TIME ZONE 'UTC')::date"),
   p.query(`SELECT d.username,d.title,d.keyword,d.first_seen_at,d.connected_at,
    d.source_id IS NOT NULL AS connected,s.enabled FROM tg_discovered_sources d
    LEFT JOIN tg_sources s ON s.id=d.source_id ORDER BY d.last_seen_at DESC LIMIT 20`),
   p.query("SELECT count(*)::int AS found,count(*) FILTER(WHERE source_id IS NOT NULL)::int AS connected FROM tg_discovered_sources")]);
  return NextResponse.json({settings:settings.rows[0],today:today.rows[0]??{queries:0,added:0},candidates:candidates.rows,totals:total.rows[0]}, {headers});
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
  b.pumpEnabled??=false;b.pumpMinAthUsd??=100000;b.pumpMaxTokens??=3;b.pumpQueries??=[];
  b.autoKeywordsEnabled??=true;b.autoKeywordsLimit??=12;b.twitterLookbackHours??=72;
  b.twitterTweetLimit??=2000;b.minKeywordPosts??=3;b.minKeywordAuthors??=2;
  const bounds:Record<string,[number,number]>={pumpMinAthUsd:[1000,1000000000],pumpMaxTokens:[1,10],intervalMinutes:[15,1440],resultsPerQuery:[1,50],queriesPerCycle:[1,10],maxQueriesPerDay:[1,200],maxNewPerDay:[1,100],maxSources:[1,1000],autoKeywordsLimit:[1,30],twitterLookbackHours:[1,168],twitterTweetLimit:[100,5000],minKeywordPosts:[2,20],minKeywordAuthors:[1,10]};
  if(typeof b.pumpEnabled!=='boolean'||!Array.isArray(b.pumpQueries)||b.pumpQueries.length>10||b.pumpQueries.some(q=>typeof q!=='string'||!/^[a-zA-Z0-9_\p{L}]{2,44}$/u.test(q))||typeof b.enabled!=="boolean"||typeof b.autoKeywordsEnabled!=="boolean"||!Array.isArray(b.keywords)||(!b.autoKeywordsEnabled&&b.keywords.length<1)||b.keywords.length>30||
   b.keywords.some(k=>typeof k!=="string"||k.trim().length<3||k.trim().length>64||/[\x00-\x1f]/.test(k))||
   Object.entries(bounds).some(([key,[min,max]])=>!Number.isInteger(b[key])||Number(b[key])<min||Number(b[key])>max))
   return NextResponse.json({error:"Проверьте ключевые слова и допустимые лимиты"},{status:400,headers});
  const keywords=[...new Set((b.keywords as string[]).map(k=>k.trim().toLowerCase()))];
  await db().query(`UPDATE tg_discovery_settings SET enabled=$1,keywords=$2,interval_minutes=$3,
   results_per_query=$4,queries_per_cycle=$5,max_queries_per_day=$6,max_new_per_day=$7,max_sources=$8,
   auto_keywords_enabled=$9,auto_keywords_limit=$10,twitter_lookback_hours=$11,twitter_tweet_limit=$12,
   min_keyword_posts=$13,min_keyword_authors=$14,pump_enabled=$15,pump_min_ath_usd=$16,pump_max_tokens=$17,pump_queries=$18,revision=revision+1,keyword_cursor=0,next_run_at=now(),last_error_code=NULL WHERE id=1`,
   [b.enabled,keywords,b.intervalMinutes,b.resultsPerQuery,b.queriesPerCycle,b.maxQueriesPerDay,b.maxNewPerDay,b.maxSources,b.autoKeywordsEnabled,b.autoKeywordsLimit,b.twitterLookbackHours,b.twitterTweetLimit,b.minKeywordPosts,b.minKeywordAuthors,b.pumpEnabled,b.pumpMinAthUsd,b.pumpMaxTokens,b.pumpQueries]);
  return NextResponse.json({ok:true},{headers});
 }catch{return NextResponse.json({error:"Не удалось сохранить настройки автопоиска"},{status:503,headers});}
}
