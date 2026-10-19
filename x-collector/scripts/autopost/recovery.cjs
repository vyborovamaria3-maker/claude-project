const {RECONCILIATION_WINDOW_MS}=require('./reconciliation.cjs');

async function recoverInterruptedJobs(c,now=Date.now()){
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid recovery timestamp');
 await c.query('BEGIN');
 try{
  const interrupted=await c.query([
   "UPDATE xc_auto_jobs",
   "SET status=CASE WHEN attempted THEN 'uncertain' WHEN retry_count<3 THEN 'queued' ELSE 'failed' END,",
   "retry_count=CASE WHEN attempted THEN retry_count ELSE LEAST(retry_count+1,3) END,",
   "scheduled_at=CASE WHEN NOT attempted AND retry_count<3 THEN GREATEST(scheduled_at,$1::bigint+30000) ELSE scheduled_at END,",
   "started_at=CASE WHEN NOT attempted AND retry_count<3 THEN NULL ELSE started_at END,",
   "finished_at=CASE WHEN NOT attempted AND retry_count<3 THEN NULL ELSE $1::bigint END,",
   "message=CASE WHEN attempted THEN 'Процесс прерван после начала отправки; проверьте X перед повтором'",
   "WHEN retry_count<3 THEN 'Восстановлено после перезапуска; повтор запланирован'",
   "ELSE 'Слишком много перезапусков до отправки; проверьте браузер и состояние задания' END,",
   "lease_until=NULL WHERE status='running' RETURNING id,status,attempted"
  ].join('\n'),[now]);
  const sync=await c.query("UPDATE xc_auto_sync SET status='queued' WHERE status='running' RETURNING id");
  const reconciliation=await c.query("UPDATE xc_auto_reconcile SET status='queued',next_check_at=LEAST(next_check_at,$1::bigint),updated_at=$1::bigint WHERE status='running' RETURNING job_id",[now]);
  const queued=await c.query([
   "INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,last_error,created_at,updated_at,finished_at)",
   "SELECT j.id,j.account_name,j.expected_handle,j.kind,COALESCE(j.attempted_at,j.started_at,j.created_at),$1::bigint,COALESCE(j.attempted_at,j.started_at,j.created_at)+$2::bigint,",
   "CASE WHEN COALESCE(j.attempted_at,j.started_at,j.created_at)+$2::bigint<=$1::bigint THEN 'manual_required' WHEN j.kind NOT IN ('post','reply') THEN 'manual_review' ELSE 'queued' END,",
   "CASE WHEN COALESCE(j.attempted_at,j.started_at,j.created_at)+$2::bigint<=$1::bigint THEN 'Результат старше 24 часов; требуется ручная проверка.'",
   "WHEN j.kind NOT IN ('post','reply') THEN 'Автоматическая сверка поддерживает только публикации и ответы.' ELSE NULL END,",
   "j.created_at,$1::bigint,CASE WHEN COALESCE(j.attempted_at,j.started_at,j.created_at)+$2::bigint<=$1::bigint OR j.kind NOT IN ('post','reply') THEN $1::bigint ELSE NULL END",
   "FROM xc_auto_jobs j WHERE j.status='uncertain'",
   "ON CONFLICT(job_id) DO UPDATE SET account_name=excluded.account_name,expected_handle=excluded.expected_handle,kind=excluded.kind,",
   "attempted_at=excluded.attempted_at,next_check_at=excluded.next_check_at,deadline_at=excluded.deadline_at,attempts=0,status=excluded.status,",
   "matched_tweet_id=NULL,candidates='[]'::jsonb,last_error=excluded.last_error,updated_at=excluded.updated_at,finished_at=excluded.finished_at",
   "WHERE xc_auto_reconcile.status='resolved' RETURNING job_id"
  ].join('\n'),[now,RECONCILIATION_WINDOW_MS]);
  await c.query('COMMIT');
  return {interruptedJobs:interrupted.rowCount||0,syncJobs:sync.rowCount||0,reconciliationsReset:reconciliation.rowCount||0,reconciliationsCreatedOrReset:queued.rowCount||0};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
}
module.exports={recoverInterruptedJobs};
