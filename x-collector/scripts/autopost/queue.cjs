const {permit}=require('./breaker.cjs');
// Both account and job are claimed atomically; a concurrent cancellation wins safely.
async function claim(c,job,now){await c.query('BEGIN');try{const account=await c.query("UPDATE x_accounts SET account_busy_until=$2 WHERE name=$1 AND role='publisher' AND status='active' AND COALESCE(account_busy_until,0)<=$3 RETURNING name",[job.account_name,now+600000,now]);if(!account.rowCount){await c.query('ROLLBACK');return false;}if(!await permit(c,'account',job.account_name,now)){await c.query('ROLLBACK');return false;}const changed=await c.query("UPDATE xc_auto_jobs SET status='running',started_at=$2,lease_until=$3 WHERE id=$1 AND status='queued' RETURNING id",[job.id,now,now+600000]);if(!changed.rowCount){await c.query('ROLLBACK');return false;}await c.query('COMMIT');return true;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}}
const eligible=`f.enabled AND (f.start_hour=f.end_hour OR (f.start_hour<f.end_hour AND $3>=f.start_hour AND $3<f.end_hour) OR (f.start_hour>f.end_hour AND ($3>=f.start_hour OR $3<f.end_hour))) AND (SELECT count(*) FROM xc_auto_jobs issued WHERE issued.account_name=j.account_name AND issued.attempted AND COALESCE(issued.attempted_at,issued.started_at)>=$4)<f.daily_limit`;
// Prioritize manual work in SQL BEFORE LIMIT, never after truncating agent jobs.
// Eligibility, account locking and the irreversible send boundary are unchanged.
async function dueJobs(c,now,paused,hour,day){
 const sql=`SELECT j.* FROM xc_auto_jobs j
 JOIN x_accounts a ON a.name=j.account_name
 WHERE j.status='queued' AND j.scheduled_at<=$1
 AND a.role='publisher' AND a.status='active' AND COALESCE(a.account_busy_until,0)<=$1
 AND NOT EXISTS(SELECT 1 FROM xc_auto_breakers b WHERE b.kind='account' AND b.subject=j.account_name
 AND (b.state='half_open' OR (b.state='open' AND b.resume_at>$1)))
 AND (j.origin='manual' OR ($2=false AND EXISTS(
  SELECT 1 FROM xc_auto_config f WHERE f.account_name=j.account_name AND ${eligible}
 )))
 ORDER BY CASE WHEN j.origin='manual' THEN 0 ELSE 1 END,j.scheduled_at,j.created_at
 LIMIT 20`;
 return (await c.query(sql,[now,paused,hour,day])).rows;
}
module.exports={claim,eligible,dueJobs};
