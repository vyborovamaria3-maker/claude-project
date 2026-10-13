const {connect}=require('./autopost/runtime.cjs');
const {resumeSource}=require('./list-core.cjs');
async function report(c){
 const lists=(await c.query(`SELECT s.list_id,s.enabled,s.interval_minutes,p.status,p.last_seen_id,p.cursor_id,p.last_completed_at,p.message,t.status AS task_status,
  (SELECT count(DISTINCT r.tweet_id)::int FROM x_task_tweets r JOIN x_tasks j ON j.id=r.task_id WHERE j.payload_json->>'list_source_id'=s.list_id OR j.payload_json->>'query'='list:'||s.list_id) AS tweets
  FROM xc_auto_sources s LEFT JOIN xc_list_checkpoints p USING(list_id) LEFT JOIN x_tasks t ON t.id=p.task_id ORDER BY s.list_id`)).rows;
 const history=(await c.query('SELECT run_id,status,count(*)::int periods FROM xc_history_windows GROUP BY run_id,status ORDER BY run_id,status')).rows;
 const accounts=(await c.query("SELECT name,status,weight_used_this_hour,weight_quota_per_hour,hour_window_start,cooldown_until FROM x_accounts WHERE role='collector' ORDER BY name")).rows;
 const discovery=(await c.query("SELECT to_regclass('xc_discovery_plan') AS present")).rows[0]?.present?{
  plan:(await c.query('SELECT enabled,list_ids,history_run_id,max_browser_accounts,message FROM xc_discovery_plan')).rows[0],
  sources:(await c.query('SELECT name,query,enabled,status,last_completed_at,message FROM xc_discovery_sources ORDER BY name')).rows,
 }:null;
 return {lists,history,accounts,discovery};
}
async function main(){const c=await connect();try{
 const [action,id]=process.argv.slice(2);
 if(action){
  if(!id||!['--resume-list','--resume-history','--refresh-members','--resume-topic'].includes(action))throw Error('Expected --resume-list LIST_ID, --resume-history RUN_ID, --refresh-members RUN_ID or --resume-topic NAME');
  await c.query('BEGIN');
  try{
   if(action==='--resume-list')await resumeSource(c,id);
   else if(action==='--resume-topic')await c.query("UPDATE xc_discovery_sources SET status='queued',task_id=NULL,message='Повтор незавершённой страницы',updated_at=$2 WHERE name=$1 AND status='partial'",[id,Date.now()]);
   else{
    if(action==='--refresh-members')await c.query("UPDATE xc_history_lists SET status='pending',attempts=0 WHERE run_id=$1",[id]);
    await c.query("UPDATE xc_history_windows SET status='pending',task_id=NULL,message=NULL WHERE run_id=$1 AND status IN ('failed','partial')",[id]);
    await c.query("UPDATE xc_history_runs SET status='running',updated_at=$2 WHERE id=$1",[id,Date.now()]);
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}
 }
 console.log(JSON.stringify(await report(c),null,2));
}finally{await c.end();}}
if(require.main===module)main().catch(e=>{console.error(e.code?'Collection status database error':e.message);process.exitCode=1;});
module.exports={report};
