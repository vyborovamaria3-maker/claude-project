const {randomUUID}=require('node:crypto');
const TOPICS=['(memecoin OR memecoins OR "meme coin" OR мемкоин OR мемкоины OR pumpfun OR "pump.fun")','(meme OR memes OR мем OR мемы)','(politics OR political OR политика OR политический)','("Elon Musk" OR "Илон Маск" OR from:elonmusk)','(Trump OR Трамп OR from:realDonaldTrump)'];
const date=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
function monthWindows(since,until){
 const result=[];let start=new Date(since+'T00:00:00Z');const end=new Date(until+'T00:00:00Z');
 if(!Number.isFinite(+start)||!Number.isFinite(+end)||start>=end)throw Error('Invalid date range');
 while(start<end){const next=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));const stop=next<end?next:end;result.push({since:date(start),until:date(stop)});start=stop;}
 return result;
}
function windowQuery(w){return w.base_query+' since:'+date(w.since_date)+' until:'+date(w.until_date)+(w.cursor_id?' max_id:'+w.cursor_id:'');}
async function startRun(c,account,since,until,listIds){
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(account)||!listIds.length||listIds.some(id=>!/^\d{1,25}$/.test(id)))throw Error('Invalid history sources');
 monthWindows(since,until);
 const id=randomUUID(),now=Date.now();
 await c.query('BEGIN');
 try{
  await c.query("SELECT name FROM x_accounts WHERE name=$1 FOR UPDATE",[account]);
  if(!(await c.query("SELECT 1 FROM x_accounts WHERE name=$1 AND role='collector' AND status='active'",[account])).rowCount)throw Error('Collector account required');
  const existing=(await c.query("SELECT id FROM xc_history_runs WHERE account_name=$1 AND status IN ('running','paused') ORDER BY created_at DESC LIMIT 1",[account])).rows[0];
  if(existing){await c.query('COMMIT');return existing.id;}
  await c.query('INSERT INTO xc_history_runs(id,account_name,since_date,until_date,topics_json,created_at,updated_at,message) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$7)',[id,account,since,until,JSON.stringify(TOPICS),now,'Обнаружение авторов списков; затем поиск истории и тематических публикаций']);
  for(const list of listIds)await c.query('INSERT INTO xc_history_lists(run_id,list_id) VALUES($1,$2)',[id,list]);
  for(const topic of TOPICS)await addWindows(c,{id,since_date:since,until_date:until},topic,null);
  await c.query('COMMIT');return id;
 }catch(e){await c.query('ROLLBACK');throw e;}
}
async function addWindows(c,run,base,author){
 const values=monthWindows(date(run.since_date),date(run.until_date)).map(w=>({...w,base,author}));
 await c.query(`INSERT INTO xc_history_windows(run_id,base_query,author_handle,since_date,until_date)
 SELECT $1,v.base,v.author,v.since::date,v.until::date FROM jsonb_to_recordset($2::jsonb) AS v(base text,author text,since text,until text) ON CONFLICT DO NOTHING`,[run.id,JSON.stringify(values)]);
}
async function advanceWindows(c,run){
 await c.query("UPDATE xc_history_windows SET status='partial',message='Операционное задание удалено; требуется повторная проверка периода' WHERE run_id=$1 AND status='queued' AND task_id IS NULL",[run.id]);
 const rows=(await c.query("SELECT w.*,t.status AS task_status,p.found, (SELECT min(tt.tweet_id::numeric)::text FROM x_task_tweets tt WHERE tt.task_id=w.task_id) AS min_id,(SELECT count(*)::int FROM x_task_tweets tt WHERE tt.task_id=w.task_id) AS saved FROM xc_history_windows w JOIN x_tasks t ON t.id=w.task_id LEFT JOIN x_task_progress p ON p.task_id=t.id WHERE w.run_id=$1 AND w.status='queued' AND t.status IN ('done','failed')",[run.id])).rows;
 for(const w of rows){
  if(w.task_status==='failed'){await c.query("UPDATE xc_history_windows SET status='failed',message='Поиск не выполнен после повторных попыток' WHERE id=$1",[w.id]);continue;}
  if(Number(w.found)>=100){
   const next=w.min_id?(BigInt(w.min_id)-1n).toString():null;
   if(!next||(w.cursor_id&&BigInt(next)>=BigInt(w.cursor_id))){await c.query("UPDATE xc_history_windows SET status='partial',message='Не удалось продвинуть поиск; окно требует проверки' WHERE id=$1",[w.id]);continue;}
   await c.query("UPDATE xc_history_windows SET status='pending',task_id=NULL,cursor_id=$2 WHERE id=$1",[w.id,next]);
  }else await c.query("UPDATE xc_history_windows SET status='done',message='Доступные результаты поиска обработаны; полнота X не гарантируется' WHERE id=$1",[w.id]);
 }
}
async function queueWindows(c,run){
 const active=Number((await c.query("SELECT count(*) FROM xc_history_windows WHERE run_id=$1 AND status='queued'",[run.id])).rows[0].count);
 if(active>=2)return;
 const rows=(await c.query("SELECT * FROM xc_history_windows WHERE run_id=$1 AND status='pending' ORDER BY (author_handle IS NOT NULL) DESC,since_date DESC,id LIMIT $2",[run.id,2-active])).rows;
 for(const w of rows){
  const now=Date.now();const payload={query:windowQuery(w),limit:100,sort:'latest',account_name:run.account_name,history_run_id:run.id,history_since:date(w.since_date),history_until:date(w.until_date),history_author:w.author_handle||undefined,history_max_id:w.cursor_id||undefined};
  const task=(await c.query("INSERT INTO x_tasks(kind,payload_json,priority,available_at,created_at,updated_at,max_attempts) VALUES('search',$1::jsonb,3,$2,$2,$2,3) RETURNING id",[JSON.stringify(payload),now])).rows[0];
  await c.query('INSERT INTO xc_history_tasks(window_id,task_id) VALUES($1,$2)',[w.id,task.id]);
  await c.query("UPDATE xc_history_windows SET task_id=$2,status='queued' WHERE id=$1",[w.id,task.id]);
 }
}
module.exports={TOPICS,date,monthWindows,windowQuery,startRun,addWindows,advanceWindows,queueWindows};
