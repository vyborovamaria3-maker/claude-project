import type {RawTweet} from './twitter-scraper';
import {exec} from './pg';
export async function persistHistory(runId:string,taskId:number){
 await exec(`INSERT INTO xc_history_posts(run_id,tweet_id,snapshot_json,first_observed_at,last_observed_at)
 SELECT $1,t.tweet_id,to_jsonb(t),$3::bigint,$3::bigint FROM x_task_tweets tt JOIN twitter_tweets t ON t.tweet_id=tt.tweet_id WHERE tt.task_id=$2
 ON CONFLICT(run_id,tweet_id) DO UPDATE SET snapshot_json=EXCLUDED.snapshot_json,last_observed_at=EXCLUDED.last_observed_at`,[runId,taskId,Date.now()]);
}
export function filterHistory(tweets:RawTweet[],payload:{history_since?:string;history_until?:string;history_author?:string;history_max_id?:string}){
 if(!payload.history_since||!payload.history_until)return tweets;
 const start=Date.parse(payload.history_since+'T00:00:00Z'),end=Date.parse(payload.history_until+'T00:00:00Z');
 return tweets.filter(t=>t.postedAt!==null&&t.postedAt>=start&&t.postedAt<end
  &&(!payload.history_author||t.authorHandle.replace(/^@/,'').toLowerCase()===payload.history_author.toLowerCase())
  &&(!payload.history_max_id||BigInt(t.id)<=BigInt(payload.history_max_id)));
}
