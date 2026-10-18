const {connect,name,handle}=require('./runtime.cjs');const {overview,enqueue,saveProvider,saveConfig}=require('./store.cjs');const {generate,choices}=require('./providers.cjs');
async function command(c,i){switch(i.action){
 case 'overview':return overview(c);
 case 'source-retry':{
  if(!/^\d{1,25}$/.test(i.id||''))throw Error('Некорректный ID списка');
  if(!(await c.query('SELECT list_id FROM xc_auto_sources WHERE list_id=$1',[i.id])).rowCount)throw Error('Источник списка не найден');
  await require('../list-core.cjs').resumeSource(c,i.id);return {ok:true,message:'Незавершённая страница поставлена на повтор'};
 }
 case 'provider-save':return saveProvider(c,i);
 case 'provider-test':{const p=(await c.query('SELECT * FROM xc_ai_providers WHERE id=$1',[i.id])).rows[0];if(!p)throw Error('Провайдер не найден');const text=await generate(p,'Return JSON only: {"actions":[]}.','Connection test.');choices(text,[],['post']);return {ok:true,message:'Подключение и формат ответа проверены'};}
 case 'config-save':return saveConfig(c,i);
 case 'pause':if(typeof i.paused!=='boolean')throw Error('paused обязателен');await c.query('UPDATE xc_auto_control SET paused=$1 WHERE id=1',[i.paused]);return {ok:true};
 case 'enqueue':return enqueue(c,i);
 case 'status':{const j=(await c.query('SELECT * FROM xc_auto_jobs WHERE id=$1',[i.id])).rows[0];if(!j)throw Error('Публикация не найдена');return j;}

 case 'reconcile-confirm':{
  if(!/^[a-f0-9-]{36}$/i.test(i.id||'')||!/^\d{1,25}$/.test(i.tweet_id||''))throw Error('Некорректный ID задания или твита');
  const row=(await c.query("SELECT r.job_id,r.account_name,r.expected_handle,r.kind,r.status AS reconciliation_status,r.candidates,j.content,j.origin,j.created_at,j.started_at,j.attempted_at,j.status AS job_status FROM xc_auto_reconcile r JOIN xc_auto_jobs j ON j.id=r.job_id WHERE r.job_id=$1",[i.id])).rows[0];
  if(!row||!['manual_review','manual_required'].includes(row.reconciliation_status)||row.job_status!=='uncertain')throw Error('Задание не ожидает ручного подтверждения');
  if(!['post','reply'].includes(row.kind))throw Error('Подтверждение поста доступно только для публикаций и ответов; для этого действия используйте ручное решение');
  const candidates=Array.isArray(row.candidates)?row.candidates:(typeof row.candidates==='string'?JSON.parse(row.candidates):[]);
  const candidate=candidates.find(value=>String(value.tweet_id)===i.tweet_id);
  if(!candidate&&i.manual_confirm!==true)throw Error(candidates.length?'Выберите найденного кандидата или подтвердите ID вручную после проверки X':'Подтвердите, что проверили публикацию в X вручную');
  const {persistPost}=require('./browser.cjs');
  await persistPost(c,row,i.tweet_id,candidate||{});
  const now=Date.now();
  await c.query('BEGIN');
  try{
   const updated=await c.query("UPDATE xc_auto_jobs SET status='published',result_id=$2,result_url=$3,message='Публикация подтверждена оператором; автоматическая повторная отправка не выполнялась.',finished_at=$4,lease_until=NULL WHERE id=$1 AND status='uncertain' RETURNING id",[row.job_id,i.tweet_id,'https://x.com/'+row.expected_handle+'/status/'+i.tweet_id,now]);
   if(!updated.rowCount)throw Error('Задание уже изменено');
   await c.query("UPDATE xc_auto_reconcile SET status='resolved',matched_tweet_id=$2,last_error='Результат подтверждён оператором.',updated_at=$3,finished_at=$3 WHERE job_id=$1 AND status IN ('manual_review','manual_required')",[row.job_id,i.tweet_id,now]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
  return {ok:true,message:'Публикация подтверждена; повторная отправка отключена'};
 }
 case 'reconcile-retry':{
  if(!/^[a-f0-9-]{36}$/i.test(i.id||'')||i.confirmed_not_performed!==true)throw Error('Подтвердите, что проверили X и действие не было выполнено');
  const row=(await c.query("SELECT r.status AS reconciliation_status,j.status AS job_status FROM xc_auto_reconcile r JOIN xc_auto_jobs j ON j.id=r.job_id WHERE r.job_id=$1",[i.id])).rows[0];
  if(!row||!['manual_review','manual_required'].includes(row.reconciliation_status)||row.job_status!=='uncertain')throw Error('Задание не ожидает ручного решения');
  const now=Date.now();
  await c.query('BEGIN');
  try{
   const updated=await c.query("UPDATE xc_auto_jobs SET status='queued',attempted=false,attempted_at=NULL,scheduled_at=$2,started_at=NULL,finished_at=NULL,lease_until=NULL,result_id=NULL,result_url=NULL,message='Оператор проверил X: действие не выполнено. Повтор разрешён вручную.' WHERE id=$1 AND status='uncertain' RETURNING id",[i.id,now]);
   if(!updated.rowCount)throw Error('Задание уже изменено');
   await c.query("UPDATE xc_auto_reconcile SET status='resolved',matched_tweet_id=NULL,candidates='[]'::jsonb,last_error='Оператор подтвердил, что действие не выполнено; повтор разрешён вручную.',updated_at=$2,finished_at=$2 WHERE job_id=$1 AND status IN ('manual_review','manual_required')",[i.id,now]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
  return {ok:true,message:'Задание возвращено в очередь по ручному подтверждению'};
 }

 case 'cancel':await c.query("UPDATE xc_auto_jobs SET status='cancelled',message='Отменено пользователем' WHERE id=$1 AND status='queued'",[i.id]);return {ok:true};
 case 'sync':{if(!name(i.name)||!handle(i.expected)||!/^\d{1,25}$/.test(i.tweet_id||'')||!(await c.query("SELECT name FROM x_accounts WHERE name=$1 AND role='publisher'",[i.name])).rowCount)throw Error('Некорректный аккаунт или ID поста');await c.query("INSERT INTO xc_auto_sync(id,account_name,expected_handle,tweet_id,created_at) VALUES($1,$2,$3,$4,$5)",[require('node:crypto').randomUUID(),i.name,i.expected.replace(/^@/,'').toLowerCase(),i.tweet_id,Date.now()]);return {ok:true,message:'Импорт/обновление поставлены в очередь'};}
 case 'stats':{if(!name(i.name))throw Error('Некорректный аккаунт');const posts=(await c.query('SELECT * FROM xc_auto_posts WHERE account_name=$1 ORDER BY posted_at DESC LIMIT 100',[i.name])).rows;const snapshots=(await c.query(`SELECT * FROM (SELECT DISTINCT ON (m.tweet_id,to_char(to_timestamp(m.measured_at/1000.0) AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD')) to_char(to_timestamp(m.measured_at/1000.0) AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') day,m.tweet_id,m.measured_at::text,m.views::text,m.likes::text,m.replies::text,m.retweets::text FROM xc_auto_metrics m JOIN xc_auto_posts p USING(tweet_id) WHERE p.account_name=$1 AND m.measured_at>$2 AND p.tweet_id IN (SELECT tweet_id FROM xc_auto_posts WHERE account_name=$1 ORDER BY posted_at DESC LIMIT 100) ORDER BY m.tweet_id,to_char(to_timestamp(m.measured_at/1000.0) AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD'),m.measured_at DESC) daily ORDER BY measured_at LIMIT 10000`,[i.name,Date.now()-30*86400000])).rows;const sync=(await c.query('SELECT * FROM xc_auto_sync WHERE account_name=$1 ORDER BY created_at DESC LIMIT 10',[i.name])).rows;return {posts,snapshots,sync};}
 default:throw Error('Неизвестная команда автопостинга');}}
module.exports={command};
if(require.main===module){process.once('message',async i=>{let c;try{c=await connect();const result=await command(c,i);process.send?.({ok:true,result});}catch(e){const safe=['23505','23503','42P01'].includes(e.code)?'Проверьте миграцию, уникальность и связанные записи.':e.code?'Ошибка базы автопостинга.':/ключ|провайдер|endpoint|http|API|ИИ|JSON|текст|аккаунт|формат|настройк|paused|действ|адаптер|ID|HTTPS|Ожидается|Некоррект|Публикация|Профиль|Ответ|Подтверд|публикац|совпад|сверк|повтор|ручн|Задание|отсутствует|проверили/i.test(e.message||'')?e.message:'Не удалось выполнить команду. Проверьте настройки.';process.send?.({ok:false,error:safe});}finally{await c?.end().catch(()=>{});if(process.connected)process.disconnect();}});}
