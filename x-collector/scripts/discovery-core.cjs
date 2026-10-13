const {advance}=require('./list-core.cjs');
const TOPICS={
 solana:'(solana OR $SOL) (memecoin OR memecoins OR "meme coin" OR мемкоин)',
 launches:'(pumpfun OR "pump.fun" OR bonk OR letsbonk OR bagsfm OR raydium OR jupiter) (token OR launch OR meme)',
 memes:'(meme OR memes OR мем OR мемы OR shitpost OR funny OR смешно OR юмор) min_faves:20',
 politics:'(Trump OR Трамп OR Musk OR Маск OR election OR elections OR политика OR politics) min_faves:20',
 news:'("breaking news" OR breaking OR срочно OR новости) min_faves:20',
 crypto:'(solana OR memecoin OR memecoins OR "pump.fun") (hack OR exploit OR listing OR Binance OR Coinbase OR SEC OR ETF)',
 culture:'(viral OR trending OR celebrity OR знаменитость OR тренд OR animal OR cat OR dog) min_faves:50',
};
async function readiness(c){
 const plan=(await c.query('SELECT * FROM xc_discovery_plan WHERE enabled')).rows[0];
 if(!plan)return {ready:false,message:'Расширенный сбор выключен'};
 const ids=plan.list_ids;
 if(!Array.isArray(ids)||ids.length!==3||new Set(ids).size!==3||!plan.history_run_id)return {ready:false,message:'Нужны три списка и связанный архив'};
 const lists=(await c.query('SELECT s.list_id,s.enabled,p.last_completed_at,p.status FROM xc_auto_sources s LEFT JOIN xc_list_checkpoints p USING(list_id) WHERE s.list_id=ANY($1::text[])',[ids])).rows;
 if(lists.length!==3||lists.some(s=>!s.enabled||!s.last_completed_at||s.status==='partial'))return {ready:false,message:'Этап 1: ожидание обработки доступных страниц трёх списков'};
 const run=(await c.query('SELECT status FROM xc_history_runs WHERE id=$1',[plan.history_run_id])).rows[0];
 if(!run||!['running','finished'].includes(run.status))return {ready:false,message:'Этап 1: архив остановлен или требует проверки'};
 const members=(await c.query('SELECT list_id,status FROM xc_history_lists WHERE run_id=$1',[plan.history_run_id])).rows;
 if(ids.some(id=>!members.some(m=>m.list_id===id&&m.status==='done')))return {ready:false,message:'Этап 1: чтение участников списков не завершено'};
 const authors=Number((await c.query('SELECT count(*) AS count FROM xc_history_authors WHERE run_id=$1',[plan.history_run_id])).rows[0].count);
 const missing=Number((await c.query('SELECT count(DISTINCT a.handle) AS count FROM xc_history_authors a WHERE a.run_id=$1 AND NOT EXISTS(SELECT 1 FROM xc_history_windows w WHERE w.run_id=a.run_id AND w.author_handle=a.handle)',[plan.history_run_id])).rows[0].count);
 const windows=(await c.query("SELECT count(*) AS total,count(*) FILTER(WHERE status!='done') AS remaining FROM xc_history_windows WHERE run_id=$1 AND author_handle IS NOT NULL",[plan.history_run_id])).rows[0];
 if(!authors||missing||!Number(windows.total)||Number(windows.remaining))return {ready:false,message:'Этап 1: архив публикаций участников ещё не завершён'};
 return {ready:true,message:'Этап 2: тематический мониторинг; полнота X и причинная связь с ценой не подтверждаются'};
}
async function tickDiscovery(c,now=Date.now()){
 const gate=await readiness(c);
 await c.query('UPDATE xc_discovery_plan SET message=$1,updated_at=$2 WHERE enabled',[gate.message,now]);
 if(!gate.ready)return gate;
 const sources=(await c.query('SELECT * FROM xc_discovery_sources WHERE enabled ORDER BY next_run,name FOR UPDATE')).rows;
 // Reuse the tested page-chain checkpoint algorithm; map its list update to this table.
 const adapter={query:(sql,args)=>c.query(sql.replaceAll('xc_list_checkpoints','xc_discovery_sources').replaceAll('WHERE list_id=$1','WHERE name=$1'),args)};
 for(const source of sources){
  if(source.status==='queued')await advance(adapter,{...source,list_id:source.name},now);
 }
 if((await c.query("SELECT 1 FROM xc_discovery_sources s JOIN x_tasks t ON t.id=s.task_id WHERE s.enabled AND t.status IN ('pending','claimed') LIMIT 1")).rows.length)return gate;
 const source=(await c.query("SELECT * FROM xc_discovery_sources WHERE enabled AND status!='partial' AND task_id IS NULL AND (status='queued' OR next_run<=$1) ORDER BY next_run,name LIMIT 1 FOR UPDATE",[now])).rows[0];
 if(!source)return gate;
 // since_id:0 is intentional: paging must retain the same lower bound.
 const query=source.query+' since_id:'+(source.last_seen_id||'0')+(source.cursor_id?' max_id:'+source.cursor_id:'');
 const payload={query,limit:100,sort:'latest',account_fallback:true,discovery_source:source.name,list_since_id:source.last_seen_id||undefined,list_max_id:source.cursor_id||undefined};
 const task=(await c.query("INSERT INTO x_tasks(kind,payload_json,priority,available_at,created_at,updated_at,max_attempts) VALUES('search',$1::jsonb,0,$2,$2,$2,3) RETURNING id",[JSON.stringify(payload),now])).rows[0];
 await c.query("UPDATE xc_discovery_sources SET task_id=$2,status='queued',next_run=$3,updated_at=$4 WHERE name=$1",[source.name,task.id,now+source.interval_minutes*60000,now]);
 return gate;
}
module.exports={TOPICS,readiness,tickDiscovery};
