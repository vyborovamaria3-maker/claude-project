const {connect,name,handle}=require('./runtime.cjs');const {overview,enqueue,saveProvider,saveConfig}=require('./store.cjs');const {generate,choices}=require('./providers.cjs');
function selectManualCandidate(candidates,tweetId,manualConfirm){const candidate=candidates.find(value=>String(value.tweet_id)===tweetId);if(!candidate&&manualConfirm!==true)throw Error(candidates.length?'Выберите найденного кандидата или подтвердите ID вручную после проверки X':'Подтвердите, что проверили публикацию в X вручную');return candidate||{};}
function manualConfirmationResult(row,tweetId){if(['post','reply'].includes(row.kind)){if(!/^\d{1,25}$/.test(tweetId||''))throw Error('Некорректный ID твита');return {resultId:tweetId,resultUrl:'https://x.com/'+row.expected_handle+'/status/'+tweetId};}if(row.kind==='follow')return {resultId:null,resultUrl:'https://x.com/'+String(row.target_handle||'').replace(/^@/,'')};if(['like','repost'].includes(row.kind))return {resultId:null,resultUrl:'https://x.com/'+String(row.target_handle||'').replace(/^@/,'')+'/status/'+row.target_id};throw Error('Неподдерживаемое действие');}
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
  if(!/^[a-f0-9-]{36}$/i.test(i.id||''))throw Error('Некорректный ID задания');
  const row=(await c.query("SELECT r.job_id,r.account_name,r.expected_handle,r.kind,r.status AS reconciliation_status,r.candidates,j.content,j.origin,j.created_at,j.started_at,j.attempted_at,j.target_id,j.target_handle,j.status AS job_status FROM xc_auto_reconcile r JOIN xc_auto_jobs j ON j.id=r.job_id WHERE r.job_id=$1",[i.id])).rows[0];
  if(!row||!['manual_review','manual_required'].includes(row.reconciliation_status)||row.job_status!=='uncertain')throw Error('Задание не ожидает ручного подтверждения');
  const isPublication=['post','reply'].includes(row.kind);
  const result=manualConfirmationResult(row,isPublication?i.tweet_id:null);
  let candidate={};
  if(isPublication){
   const candidates=Array.isArray(row.candidates)?row.candidates:(typeof row.candidates==='string'?JSON.parse(row.candidates):[]);
   candidate=selectManualCandidate(candidates,i.tweet_id,i.manual_confirm);
   const {persistPost}=require('./browser.cjs');
   await persistPost(c,row,i.tweet_id,candidate);
  }else if(i.manual_confirm!==true){throw Error('Подтвердите, что проверили X и действие действительно выполнено');}
  const now=Date.now();
  await c.query('BEGIN');
  try{
   const updated=await c.query("UPDATE xc_auto_jobs SET status='published',result_id=$2,result_url=$3,message=$4,finished_at=$5,lease_until=NULL WHERE id=$1 AND status='uncertain' RETURNING id",[row.job_id,result.resultId,result.resultUrl,isPublication?'Публикация подтверждена оператором; автоматическая повторная отправка не выполнялась.':'Действие подтверждено оператором; автоматическая повторная отправка не выполнялась.',now]);
   if(!updated.rowCount)throw Error('Задание уже изменено');
   await c.query("UPDATE xc_auto_reconcile SET status='resolved',matched_tweet_id=$2,last_error='Результат подтверждён оператором.',updated_at=$3,finished_at=$3 WHERE job_id=$1 AND status IN ('manual_review','manual_required')",[row.job_id,result.resultId,now]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
  return {ok:true,message:isPublication?'Публикация подтверждена; повторная отправка отключена':'Действие подтверждено; повторная отправка отключена'};
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
module.exports={command,selectManualCandidate,manualConfirmationResult};
if(require.main===module){process.once('message',async i=>{let c;try{c=await connect();const result=await command(c,i);process.send?.({ok:true,result});}catch(e){const safe=['23505','23503','42P01'].includes(e.code)?'Проверьте миграцию, уникальность и связанные записи.':e.code?'Ошибка базы автопостинга.':/ключ|провайдер|endpoint|http|API|ИИ|JSON|текст|аккаунт|формат|настройк|paused|действ|адаптер|ID|HTTPS|Ожидается|Некоррект|Публикация|Профиль|Ответ|Подтверд|публикац|совпад|сверк|повтор|ручн|Задание|отсутствует|проверили/i.test(e.message||'')?e.message:'Не удалось выполнить команду. Проверьте настройки.';process.send?.({ok:false,error:safe});}finally{await c?.end().catch(()=>{});if(process.connected)process.disconnect();}});}
