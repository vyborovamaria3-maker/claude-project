const {chromium}=require('playwright');
const {randomUUID}=require('node:crypto');
const {connect,unseal,config,name}=require('./autopost/runtime.cjs');
const {launchLoginBrowser}=require('./test-publish-browser.cjs');
const {playwrightProxy,toPublicProxy,computeScore,classifyError,recordAccountError,messages}=require('./account-health.cjs');
const {check}=require('./proxy-check.cjs');
async function run(account){
 if(!name(account))throw Error('Invalid account');
 let errorType;
 const steps=Object.fromEntries(['database','session','proxy','browser','x'].map(k=>[k,{status:'pending'}]));
 let c,browser,a,hasProxy=false,proxy,state,identity={};const owner='check-'+randomUUID();
 const report=(key,status,message)=>{steps[key]={status,message};if(process.send)process.send({status:'running',name:account,steps,...computeScore(steps,hasProxy)});};
 async function step(key,fn){report(key,'running');try{await fn();report(key,'passed');return true;}catch(e){const type=classifyError(e);errorType=type;report(key,'failed',String(e?.message)==='ACCOUNT_BUSY'?'Аккаунт занят или удалён. Обновите список и повторите после освобождения.':key==='x'&&/timeout|ERR_TIMED_OUT|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(String(e?.message))?'X не ответил. Проверьте прокси этого аккаунта.':messages[type]);if(c&&a)await recordAccountError(c,account,e).catch(()=>{});return false;}}
 try{
  if(await step('database',async()=>{
   c=await connect();const now=Date.now();
   a=(await c.query('UPDATE x_accounts SET account_busy_until=$2,account_claimed_by=$3 WHERE name=$1 AND account_busy_until<=$4 RETURNING *',[account,now+175000,owner,now])).rows[0];
   if(!a)throw Error('ACCOUNT_BUSY');hasProxy=Boolean(a.proxy_json);
  })){
   const sessionOK=await step('session',async()=>{
    try{state=JSON.parse(unseal(a.session_encrypted));}catch{throw Error('SESSION_EXPIRED');}
    const cookies=Array.isArray(state.cookies)?state.cookies:[];
    if(!['auth_token','ct0'].every(n=>cookies.some(k=>k.name===n&&k.value&&/(^|\.)((x|twitter)\.com)$/i.test(k.domain||'')&&(k.expires===-1||k.expires>Date.now()/1000))))throw Error('SESSION_EXPIRED');
   });
   let proxyOK=true;
   if(hasProxy)proxyOK=await step('proxy',async()=>{const r=await check(a.proxy_json);proxy=r.proxy;if(!r.ok)throw Error('PROXY_FAILED');});
   else report('proxy','skipped','Прокси не задан — прямое соединение');
   if(sessionOK&&proxyOK){
    const browserOK=await step('browser',async()=>{
     const opened=await launchLoginBrowser(chromium,{...process.env,...config()},{proxy:playwrightProxy(a.proxy_json),headless:true});browser=opened.browser;
    });
    if(browserOK)await step('x',async()=>{
     const context=await browser.newContext({storageState:state,...(a.user_agent?{userAgent:a.user_agent}:{}),...(a.timezone?{timezoneId:a.timezone}:{}),...(a.language?{locale:a.language}:{})});
     const page=await context.newPage();
     const response=await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});
     if(response?.status()===429)throw Error('RATE_LIMIT');
     if(response?.status()===403||/account\/access/.test(page.url()))throw Error('X_BLOCKED');
     if(/\/(i\/flow\/)?login/.test(page.url()))throw Error('SESSION_EXPIRED');
     const href=await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href',{timeout:15000});
     if(!/^\/[A-Za-z0-9_]{1,15}$/.test(href||''))throw Error('X_BLOCKED');
     identity.handle=href.slice(1);
     if(a.publisher_handle&&identity.handle.toLowerCase()!==a.publisher_handle.toLowerCase())throw Error('Profile mismatch');
     // Identity details are optional; home authorization above is the readiness gate.
     try{
      await page.goto('https://x.com/'+identity.handle,{waitUntil:'domcontentloaded',timeout:15000});
      identity.display_name=(await page.locator('[data-testid="UserName"]').first().innerText({timeout:5000})).split('\n')[0].slice(0,200);
      const avatar=await page.locator('[data-testid^="UserAvatar-Container"] img').first().getAttribute('src',{timeout:3000}).catch(()=>null);
      if(avatar&&new URL(avatar).hostname==='pbs.twimg.com')identity.avatar_url=avatar;
      const joined=await page.locator('[data-testid="UserJoinDate"]').first().innerText({timeout:2000}).catch(()=>null);
      const date=joined?Date.parse(joined.replace(/^Joined\s+/i,'')):NaN;if(Number.isFinite(date))identity.x_created_at=date;
     }catch{/* Best-effort profile metadata. */}
    });
   }
  }
  for(const [key,value] of Object.entries(steps))if(value.status==='pending')report(key,'skipped','Предыдущий шаг не пройден');
  const result={name:account,status:'done',steps,...computeScore(steps,hasProxy),checked_at:Date.now(),errorType,proxy:toPublicProxy(proxy||a?.proxy_json)};
  if(a&&a.status!=='active'){result.ready=false;result.message='Аккаунт неактивен — исполнитель не будет его использовать.';}
  if(c&&a){
   await c.query('UPDATE x_accounts SET health_score=$2,last_check_at=$3,last_check_json=$4,display_name=COALESCE($5,display_name),avatar_url=COALESCE($6,avatar_url),x_created_at=COALESCE($7,x_created_at),publisher_handle=COALESCE(publisher_handle,$8),proxy_json=COALESCE($9,proxy_json),updated_at=GREATEST(updated_at+1,$3::bigint) WHERE name=$1 AND account_claimed_by=$10',[account,result.score,result.checked_at,JSON.stringify(result),identity.display_name||null,identity.avatar_url||null,identity.x_created_at||null,identity.handle||null,proxy?JSON.stringify(proxy):null,owner]);
  }
  return result;
 }finally{
  await browser?.close().catch(()=>{});
  if(c){await c.query('UPDATE x_accounts SET account_busy_until=0,account_claimed_by=NULL WHERE name=$1 AND account_claimed_by=$2',[account,owner]).catch(()=>{});await c.end().catch(()=>{});}
 }
}
if(require.main===module)run(process.argv[2]).then(result=>{if(process.send){process.send(result,()=>process.disconnect());}else process.stdout.write(JSON.stringify(result)+'\n');}).catch(()=>{const result={status:'failed',message:'Проверка не выполнена. Обновите аккаунты и проверьте базу.'};if(process.send)process.send(result,()=>process.disconnect());else process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=1;});
module.exports={run};
