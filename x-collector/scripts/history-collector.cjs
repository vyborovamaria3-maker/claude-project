const {connect,unseal,config}=require('./autopost/runtime.cjs');
const {addWindows,advanceWindows,queueWindows}=require('./history-core.cjs');
const {playwrightProxy,recordAccountError}=require('./account-health.cjs');
const {launchLoginBrowser}=require('./test-publish-browser.cjs');
const {chromium}=require('playwright');
let stopping=false,browser;
function configureEnvironment(settings=config()){
 if(!settings.DATABASE_URL)throw Error('Collector database required');
 process.env.DATABASE_URL=settings.DATABASE_URL;
 if(settings.MASTER_KEY)process.env.MASTER_KEY=settings.MASTER_KEY;
}
process.on('message',m=>{if(m?.stop)stopping=true;});process.on('disconnect',()=>{stopping=true;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
async function members(c,run,list,accounts){
 const owner='history-'+run.id;const account=await accounts.pickAccount('search',owner,run.account_name);
 if(!account){await c.query('UPDATE xc_history_runs SET message=$2,updated_at=$3 WHERE id=$1',[run.id,'Ожидание доступного collector и его часовой квоты',Date.now()]);return false;}
 const leaseMs=accounts.leaseMs||300000;
 let leaseLost=false;
 const timer=setInterval(()=>{void accounts.extendAccountLease(account.name,owner,leaseMs).then(ok=>{if(!ok)leaseLost=true;}).catch(()=>{leaseLost=true;});},Math.max(1000,Math.floor(leaseMs/2)));
 try{
  const opened=await launchLoginBrowser(chromium,process.env,{headless:true,proxy:playwrightProxy(account.proxy_json)});browser=opened.browser;
  const context=await browser.newContext({storageState:JSON.parse(unseal(account.session_encrypted)),locale:account.language||'en-US',userAgent:account.user_agent||undefined,timezoneId:account.timezone||undefined});
  const page=await context.newPage();const response=await page.goto('https://x.com/i/lists/'+list.list_id+'/members',{waitUntil:'domcontentloaded',timeout:60000});
  if(response?.status()===429)throw Error('RATE_LIMIT');
  if(/\/(i\/flow\/)?login/.test(page.url()))throw Error('SESSION_EXPIRED');
  await page.waitForSelector('[data-testid="UserCell"], [data-testid="emptyState"]',{timeout:15000});
  const seen=new Set();let stale=0;const deadline=Date.now()+180000;
  while(!stopping&&stale<4){
   if(leaseLost)throw Error('Account lease lost');
   if(Date.now()>deadline)throw Error('MEMBERS_INCOMPLETE');
   const found=await page.locator('[data-testid="UserCell"]').evaluateAll(cells=>cells.flatMap(cell=>Array.from(cell.querySelectorAll('a[href]')).map(a=>a.getAttribute('href'))).filter(h=>/^\/[A-Za-z0-9_]{1,15}$/.test(h||'')).map(h=>h.slice(1).toLowerCase()));
   const before=seen.size;for(const h of found)seen.add(h);stale=seen.size===before?stale+1:0;
   for(const h of found)await c.query('INSERT INTO xc_history_authors(run_id,list_id,handle) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[run.id,list.list_id,h]);
   await c.query('UPDATE xc_history_runs SET message=$2,updated_at=$3 WHERE id=$1',[run.id,'Чтение участников списка '+list.list_id+': найдено '+seen.size,Date.now()]);
   await page.mouse.wheel(0,1800);await page.waitForTimeout(800);
  }
  if(stopping)return false;if(leaseLost)throw Error('Account lease lost');
  await accounts.recordSuccess(account.name);
  await c.query("UPDATE xc_history_lists SET status='done' WHERE run_id=$1 AND list_id=$2",[run.id,list.list_id]);
  return true;
 }catch(error){
  await accounts.recordError(account.name,error.message==='RATE_LIMIT'?'rate_limit':'other').catch(()=>{});
  await recordAccountError(c,account.name,error).catch(()=>{});
  await c.query("UPDATE xc_history_lists SET attempts=attempts+1,status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'pending' END WHERE run_id=$1 AND list_id=$2",[run.id,list.list_id]);
  await c.query('UPDATE xc_history_runs SET message=$2,updated_at=$3 WHERE id=$1',[run.id,'Участники списка не загрузились. Сохранённые авторы не потеряны; будут повторные попытки.',Date.now()]);
  return false;
 }finally{clearInterval(timer);if(browser){await browser.close().catch(()=>{});browser=undefined;}await accounts.releaseAccount(account.name,owner);}
}
async function tick(c,accounts){
 const runs=(await c.query("SELECT * FROM xc_history_runs WHERE status='running' ORDER BY created_at")).rows;
 for(const run of runs){
  if(stopping)return;
  if(!run.account_name){await c.query("UPDATE xc_history_runs SET status='paused',message='Аккаунт удалён: назначьте collector для продолжения' WHERE id=$1",[run.id]);continue;}
  const list=(await c.query("SELECT * FROM xc_history_lists WHERE run_id=$1 AND status='pending' ORDER BY list_id LIMIT 1",[run.id])).rows[0];
  if(list){await members(c,run,list,accounts);continue;}
  const authors=(await c.query('SELECT DISTINCT handle FROM xc_history_authors WHERE run_id=$1',[run.id])).rows;
  for(const author of authors)await addWindows(c,run,'from:'+author.handle,author.handle);
  await c.query('BEGIN');
  try{await advanceWindows(c,run);await queueWindows(c,run);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}
  const remaining=Number((await c.query("SELECT count(*) FROM xc_history_windows WHERE run_id=$1 AND status IN ('pending','queued')",[run.id])).rows[0].count);
  await c.query("UPDATE xc_history_runs SET status=$2,message=$3,updated_at=$4 WHERE id=$1",[run.id,remaining?'running':'finished',remaining?'Исторический поиск: авторы списков и темы; прогресс сохраняется в базе':'Доступные результаты обработаны. Проверьте ошибки и неполные окна; полнота поиска X не гарантируется.',Date.now()]);
 }
}
async function main(){
 configureEnvironment();
 const accounts={...require('../dist/lib/trade/account-manager.js'),leaseMs:require('../dist/lib/trade/config.js').getConfig().sessions.leaseMs};const c=await connect();
 try{
  if(!(await c.query('SELECT pg_try_advisory_lock(742098534) AS locked')).rows[0].locked)return;
  console.log('Historical collector running; persistent progress and account quotas enabled.');
  while(!stopping){try{await tick(c,accounts);if((await c.query("SELECT 1 FROM xc_history_windows w JOIN xc_history_runs r ON r.id=w.run_id WHERE w.status='queued' AND r.status='running' LIMIT 1")).rowCount)await require('../dist/lib/collector/runtime.js').ensureWorker();}catch{console.error('Historical cycle failed; progress is preserved. Check database and worker.');await c.query("UPDATE xc_history_runs SET message='Исторический цикл не выполнен. Прогресс сохранён; проверьте worker и базу.',updated_at=$1 WHERE status='running'",[Date.now()]).catch(()=>{});}if(!stopping)await new Promise(r=>setTimeout(r,10000));}
 }finally{await require('../dist/lib/collector/runtime.js').stopManagedWorker();await c.query('SELECT pg_advisory_unlock(742098534)').catch(()=>{});await c.end();await require('../dist/lib/trade/pg.js').closePool();await require('../dist/lib/trade/logger.js').closeLogger();if(process.connected)process.disconnect();}
}
if(require.main===module)main().catch(()=>{console.error('Cannot start historical collector. Build X Collector and apply migrations.');process.exitCode=1;if(process.connected)process.disconnect();});
module.exports={tick,members,configureEnvironment};
