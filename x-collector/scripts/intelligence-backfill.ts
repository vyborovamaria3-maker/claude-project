import 'dotenv/config';
import {q,tx,closePool} from '../lib/trade/pg';
import {recordRawBatch} from '../lib/trade/intelligence-store';
// Bounded, restart-safe insertion: immutable originals remain in existing stores.
async function main(){
 let imported=0;
 for(const table of ['twitter_tweet_observations','twitter_profile_observations'] as const){
  const key=table==='twitter_tweet_observations'?'tweet_id':'handle';let afterId='',afterDate='1970-01-01T00:00:00Z';
  for(;;){
   const rows=await q<{external_id:string;observed_at:Date;raw:unknown}>(`SELECT ${key} external_id,observed_at,raw FROM ${table} WHERE (observed_at,${key})>($1::timestamptz,$2::text) ORDER BY observed_at,${key} LIMIT 500`,[afterDate,afterId]);
   if(!rows.length)break;
   await tx(c=>recordRawBatch(c,rows.map(r=>({eventType:table==='twitter_tweet_observations'?'TWEET':'PROFILE',externalId:r.external_id,payload:r.raw,collectedAt:new Date(r.observed_at)}))));
   imported+=rows.length;const last=rows.at(-1)!;afterDate=new Date(last.observed_at).toISOString();afterId=last.external_id;
  }
 }
 console.log(JSON.stringify({observations_scanned:imported,note:'Replay deduplicates unchanged raw events; historical archive snapshots remain independently preserved'}));
}
main().catch(()=>{console.error('Intelligence backfill failed; existing data preserved');process.exitCode=1;}).finally(closePool);
