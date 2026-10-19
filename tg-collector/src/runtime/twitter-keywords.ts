import {createHash} from "node:crypto";
import pg from "pg";
import {refreshPumpKeywords,tweetPumpMints,tweetPumpTickers,type PumpSettings} from "./pump-keywords.js";
export type TweetKeywordSettings={auto_keywords_enabled:boolean;auto_keywords_limit:number;
 twitter_lookback_hours:number;twitter_tweet_limit:number;min_keyword_posts:number;min_keyword_authors:number;revision:number};
type Tweet={tweet_id:string;text:string;handle:string};
const generic=new Set('usd usdt usdc http https www free giveaway follow retweet twitter news update buy sell hold moon bullish bearish pump dump nft new now today aapl tsla nvda msft amzn goog meta spy qqq travel photography music followback'.split(' '));
const topics=['bitcoin','ethereum','solana','memecoin','pumpfun','dexscreener','airdrop','defi','dogecoin','bonk','pepe','криптовалюта','мемкоины'];
export function extractTwitterKeywords(rows:Tweet[],options:{limit:number;minPosts:number;minAuthors:number}) {
 const counts=new Map<string,{posts:number;authors:Set<string>;weight:number}>();
 const seen=new Set<string>();
 for(const row of rows){
  const text=(row.text||'').normalize('NFKC').slice(0,8192);
  const normalized=text.toLowerCase().replace(/https?:\/\/\S+/g,'[url]').replace(/0x[a-f0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g,'[address]').replace(/\s+/g,' ').trim();
  const fingerprint=createHash('sha256').update(normalized).digest('hex');
  if(!normalized||seen.has(fingerprint))continue;seen.add(fingerprint);
  const crypto=/crypto|memecoin|solana|pump\.?fun|dexscreener|bitcoin|ethereum|airdrop|крипт|мемкоин|\$[a-z][a-z0-9_]{2,19}/i.test(text);
  if(!crypto)continue;
  const terms=new Map<string,number>();
  for(const match of text.matchAll(/([$#])([\p{L}][\p{L}\p{N}_]{2,23})(?![\p{L}\p{N}_])/gu)){
   const keyword=match[2].toLowerCase();
   if(!generic.has(keyword)&&!/^(?:0x|test_|secret|token_)/.test(keyword))terms.set(keyword,match[1]==='$'?3:2);
  }
  for(const topic of topics)if(new RegExp('(^|[^\\p{L}\\p{N}_])'+topic+'([^\\p{L}\\p{N}_]|$)','u').test(text.toLowerCase())&&!terms.has(topic))terms.set(topic,1);
  const author=(row.handle||'').trim().toLowerCase();if(!author)continue;
  for(const [keyword,weight] of terms){const item=counts.get(keyword)??{posts:0,authors:new Set<string>(),weight:0};item.posts++;item.authors.add(author);item.weight+=weight;counts.set(keyword,item);}
 }
 return [...counts].filter(([,v])=>v.posts>=options.minPosts&&v.authors.size>=options.minAuthors)
  .map(([keyword,v])=>({keyword,posts:v.posts,authors:v.authors.size,score:v.posts+2*v.authors.size+v.weight}))
  .sort((a,b)=>b.score-a.score||a.keyword.localeCompare(b.keyword)).slice(0,options.limit);
}
export async function readTwitterKeywordPosts(url:string,hours:number,limit:number):Promise<Tweet[]> {
 if(!Number.isInteger(hours)||hours<1||hours>168||!Number.isInteger(limit)||limit<100||limit>5000)throw Error('Invalid keyword scan limits');
 const source=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:4000,idleTimeoutMillis:1000});
 let tx:pg.PoolClient|undefined;
 try{
  tx=await source.connect();
  await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='4s'");
  const now=Date.now(),cutoff=now-hours*3600000;
  const rows=await tx.query<Tweet>(`SELECT tweet_id,left(text,8192) AS text,left(handle,64) AS handle
   FROM twitter_tweets WHERE ((first_seen_at BETWEEN $1 AND $2) OR (first_seen_at BETWEEN $3 AND $4))
   AND (posted_at IS NULL OR (posted_at BETWEEN $1 AND $2) OR (posted_at BETWEEN $3 AND $4))
   ORDER BY first_seen_at DESC LIMIT $5`,[cutoff,now+3600000,Math.floor(cutoff/1000),Math.floor((now+3600000)/1000),limit]);
  await tx.query('COMMIT');return rows.rows;
 }catch(error){if(tx)await tx.query('ROLLBACK');throw error;}finally{tx?.release();await source.end();}
}
export async function refreshTwitterKeywords(settings:TweetKeywordSettings & Partial<PumpSettings>):Promise<string[]> {
 if(!settings.auto_keywords_enabled){return settings.pump_enabled?refreshPumpKeywords(settings as PumpSettings,[],[]):[];}
 const {pool}=await import("../db.js");
 const url=process.env.TG_DISCOVERY_TWITTER_DATABASE_URL;
 if(!url){await pool.query("UPDATE tg_discovery_settings SET keyword_error_code='TWITTER_NOT_CONFIGURED' WHERE id=1");return settings.pump_enabled?refreshPumpKeywords(settings as PumpSettings,[],[]):[];}
 try{
  const rows=await readTwitterKeywordPosts(url,settings.twitter_lookback_hours,settings.twitter_tweet_limit);
  const words=extractTwitterKeywords(rows,{limit:settings.auto_keywords_limit,minPosts:settings.min_keyword_posts,minAuthors:settings.min_keyword_authors});
  await pool.query(`UPDATE tg_discovery_settings SET generated_keywords=$2,keyword_stats=$3::jsonb,
   keyword_refreshed_at=now(),keyword_post_count=$4,keyword_error_code=NULL WHERE id=1 AND revision=$1`,
   [settings.revision,words.map(w=>w.keyword),JSON.stringify(words),rows.length]);
  const pump=settings.pump_enabled?await refreshPumpKeywords(settings as PumpSettings,tweetPumpTickers(rows.map(r=>r.text),settings.pump_max_tokens??3),tweetPumpMints(rows.map(r=>r.text),settings.pump_max_tokens??3)):[];
  return [...pump,...words.map(w=>w.keyword)];
 }catch{await pool.query("UPDATE tg_discovery_settings SET keyword_error_code='TWITTER_READ_UNAVAILABLE' WHERE id=1");return [];}
}
