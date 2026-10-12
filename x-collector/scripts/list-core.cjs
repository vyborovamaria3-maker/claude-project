// Advance a checkpoint only after a complete chain of bounded search pages.
const largest=(a,b)=>!a?b:!b?a:BigInt(a)>BigInt(b)?a:b;
async function advance(c,state,now){
 if(!state.task_id)return;
 const task=(await c.query('SELECT status,payload_json FROM x_tasks WHERE id=$1',[state.task_id])).rows[0];
 if(task&&['pending','claimed'].includes(task.status))return;
 if(!task||task.status!=='done'){
  await c.query("UPDATE xc_list_checkpoints SET status='partial',message='Страница не завершена; сохранённые твиты и курсор сохранены',updated_at=$2 WHERE list_id=$1",[state.list_id,now]);return;
 }
 if(!task.payload_json?.list_source_id){
  await c.query('UPDATE xc_list_checkpoints SET task_id=NULL,updated_at=$2 WHERE list_id=$1',[state.list_id,now]);return;
 }
 const result=(await c.query('SELECT count(*)::int saved,min(tweet_id::numeric)::text oldest,max(tweet_id::numeric)::text newest FROM x_task_tweets WHERE task_id=$1',[state.task_id])).rows[0];
 const progress=(await c.query('SELECT found FROM x_task_progress WHERE task_id=$1',[state.task_id])).rows[0];
 const head=largest(state.pending_head_id,result.newest||'');
 if(Number(progress?.found??result.saved)>=100){
  const cursor=result.oldest?(BigInt(result.oldest)-1n).toString():'';
  if(!cursor||(state.cursor_id&&BigInt(cursor)>=BigInt(state.cursor_id))){
   await c.query("UPDATE xc_list_checkpoints SET status='partial',message='Курсор не продвинулся; полнота не подтверждена',updated_at=$2 WHERE list_id=$1",[state.list_id,now]);return;
  }
  await c.query("UPDATE xc_list_checkpoints SET cursor_id=$2,pending_head_id=$3,task_id=NULL,updated_at=$4 WHERE list_id=$1",[state.list_id,cursor,head,now]);
 }else{
  await c.query("UPDATE xc_list_checkpoints SET last_seen_id=$2,pending_head_id='',cursor_id='',task_id=NULL,status='idle',message='Доступные страницы обработаны; полнота выдачи X не гарантируется',last_completed_at=$3,updated_at=$3 WHERE list_id=$1",[state.list_id,largest(state.last_seen_id,head),now]);
 }
}
async function tickSources(c,now=Date.now()){
 const sources=(await c.query('SELECT * FROM xc_auto_sources WHERE enabled ORDER BY list_id')).rows;
 for(const source of sources){
  await c.query('INSERT INTO xc_list_checkpoints(list_id) VALUES($1) ON CONFLICT DO NOTHING',[source.list_id]);
  let state=(await c.query('SELECT * FROM xc_list_checkpoints WHERE list_id=$1 FOR UPDATE',[source.list_id])).rows[0];
  if(state.status==='queued')await advance(c,state,now);
  state=(await c.query('SELECT * FROM xc_list_checkpoints WHERE list_id=$1',[source.list_id])).rows[0];
  if(state.status==='partial'||state.task_id)continue;
  if(state.status==='idle'&&Number(source.next_run)>now)continue;
  const base='list:'+source.list_id;
  // Search sorts original posts by time; list feeds can contain old repost IDs.
  const query=base+' since_id:'+(state.last_seen_id||'0')+(state.cursor_id?' max_id:'+state.cursor_id:'');
  const active=(await c.query("SELECT id FROM x_tasks WHERE kind='search' AND (payload_json->>'list_source_id'=$1 OR payload_json->>'query'=$2) AND status IN ('pending','claimed') ORDER BY id LIMIT 1",[source.list_id,base])).rows[0];
  const payload={query,limit:100,sort:'latest',account_fallback:true,list_source_id:source.list_id,list_since_id:state.last_seen_id||undefined,list_max_id:state.cursor_id||undefined};
  const priority=state.cursor_id&&!state.last_seen_id?1:2;
  const id=active?.id||(await c.query("INSERT INTO x_tasks(kind,payload_json,priority,available_at,created_at,updated_at,max_attempts) VALUES('search',$1::jsonb,$3,$2,$2,$2,3) RETURNING id",[JSON.stringify(payload),now,priority])).rows[0].id;
  if(active)await c.query("UPDATE x_tasks SET payload_json=payload_json||$2::jsonb,priority=$3 WHERE id=$1 AND status='pending'",[id,JSON.stringify(payload),priority]);
  await c.query("UPDATE xc_list_checkpoints SET task_id=$2,status='queued',updated_at=$3 WHERE list_id=$1",[source.list_id,id,now]);
  await c.query('UPDATE xc_auto_sources SET next_run=$2,last_task_id=$3 WHERE list_id=$1',[source.list_id,now+source.interval_minutes*60000,id]);
 }
}
async function resumeSource(c,id){
 await c.query("UPDATE xc_list_checkpoints SET status='queued',task_id=NULL,message='Повтор незавершённой страницы',updated_at=$2 WHERE list_id=$1 AND status='partial'",[id,Date.now()]);
}
module.exports={advance,tickSources,resumeSource};
