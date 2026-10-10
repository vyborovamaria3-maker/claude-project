// Publisher diagnostics: database → session → browser → X.
// Prints account name, roles, cookie names, URLs and error codes only — never secrets.
const {chromium}=require('playwright');
const {config,unseal,connect}=require('./autopost/runtime.cjs');
const {launchLoginBrowser}=require('./test-publish-browser.cjs');
const {parseProxy}=require('./x-proxy.cjs');

const results=[];
function pass(label,details){results.push({ok:true,label});console.log('  [ok] '+label+(details?' — '+details:''));}
function fail(label,details){results.push({ok:false,label});console.log('  [fail] '+label+(details?' — '+details:''));}
function info(text){console.log('  [info] '+text);}

// Only well-known Playwright/network error codes are shown; anything else stays redacted.
function safeError(e){
 const m=String((e&&e.message)||e);
 const net=m.match(/net::[A-Za-z0-9_]+/);
 if(net)return net[0];
 if(/Timeout \d+ms exceeded/i.test(m))return 'timeout: X не ответил вовремя';
 if(/Target page, context or browser has been closed/i.test(m))return 'страница закрыта до ответа X';
 if(/frame was detached/i.test(m))return 'фрейм откреплён: X оборвал навигацию';
 if(/MASTER_KEY/.test(m))return 'MASTER_KEY задан неверно';
 if(/browsermissing|browserconfig/.test(m))return 'не найден Chrome/Edge/Chromium';
 return 'ошибка (детали скрыты, чтобы не раскрывать секреты)';
}

function hasCookies(names,required){return required.every(n=>names.has(n));}

async function main(){
 const name=process.argv[2];
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(name||'')){
  console.error('Usage: node scripts/diagnose-publisher.cjs ACCOUNT_NAME');
  process.exitCode=1;
  return;
 }
 console.log('[diagnose] account: '+name);

 let c,browser;
 try{c=await connect();}catch{fail('подключение к базе','DATABASE_URL недоступен');process.exitCode=1;return;}
 try{
  const row=(await c.query('SELECT role,status,publisher_handle,session_encrypted,proxy_json,user_agent,timezone,language FROM x_accounts WHERE name=$1',[name])).rows[0];
  if(!row){fail('аккаунт существует','запись не найдена');process.exitCode=1;return;}
  pass('аккаунт существует');
  if(row.role==='publisher')pass('role = publisher');else{fail('role = publisher',String(row.role));}
  if(row.status==='active')pass('status = active');else{fail('status = active',String(row.status));}
  if(row.publisher_handle)info('publisher_handle в базе: '+row.publisher_handle);else info('publisher_handle в базе не заполнен');

  const proxy=parseProxy(row.proxy_json);
  info('прокси аккаунта: '+(proxy?proxy.server:'не задан (весь трафик идёт напрямую)'));

  let state;
  try{state=JSON.parse(unseal(row.session_encrypted));}catch{fail('session decrypt','сессия не расшифровывается — проверьте MASTER_KEY');process.exitCode=1;return;}
  const storedCookies=Array.isArray(state.cookies)?state.cookies:[];
  const storedNames=new Set(storedCookies.map(c0=>c0.name));
  pass('session decrypt','storage state: cookies '+storedCookies.length+', origins '+(Array.isArray(state.origins)?state.origins.length:0));
  if(hasCookies(storedNames,['auth_token','ct0']))pass('cookies auth_token/ct0 в сессии');else fail('cookies auth_token/ct0 в сессии','в сохранённой сессии нет обязательных cookies');

  let opened;
  try{opened=await launchLoginBrowser(chromium,{...process.env,...config()},{proxy});browser=opened.browser;pass('browser launch',opened.label+(proxy?' через '+proxy.server:''));}
  catch(e){fail('browser launch',safeError(e));process.exitCode=1;return;}

  const context=await browser.newContext({storageState:state,userAgent:row.user_agent||undefined,timezoneId:row.timezone||undefined,locale:row.language||undefined});
  const liveNames=new Set((await context.cookies('https://x.com')).map(c0=>c0.name));
  if(hasCookies(liveNames,['auth_token','ct0']))pass('cookies в браузерном контексте');else fail('cookies в браузерном контексте','auth_token/ct0 не попали в контекст');

  const page=await context.newPage();
  let navFailed=false;
  try{await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:45000});pass('открытие X','https://x.com/home');}
  catch(e){navFailed=true;fail('открытие X',safeError(e));}

  if(!navFailed&&!page.isClosed()){
   const url=page.url();
   const title=await page.title().catch(()=>'');
   const publicUrl=new URL(url);
   pass('текущий URL',publicUrl.origin+publicUrl.pathname);
   pass('title',title||'(пусто)');

   if(/\/(?:i\/flow\/)?login/.test(url))fail('авторизация','X перенаправил на login — сессия истекла или недействительна');
   else pass('авторизация','редиректа на login нет');

   const href=await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href',{timeout:25000}).catch(()=>null);
   if(!href||!/^\/[A-Za-z0-9_]{1,15}$/.test(href))fail('username профиля','ссылка профиля не найдена на странице');
   else{
    const live=href.slice(1);
    pass('username профиля',live);
    if(row.publisher_handle&&live.toLowerCase()!==row.publisher_handle.toLowerCase())fail('совпадение username с базой','в базе '+row.publisher_handle+', в X '+live);
    else if(row.publisher_handle)pass('совпадение username с базой',live);
   }
  }else if(navFailed){
   fail('текущий URL','страница не загрузилась');
   if(page.isClosed())info('браузер закрыл страницу после обрыва навигации — это следствие недоступности X, а не поломки скрипта');
  }
 }finally{
  await browser?.close().catch(()=>{});
  await c.end().catch(()=>{});
 }

 const failed=results.filter(r=>!r.ok);
 console.log('[diagnose] итог: '+ (results.length-failed.length) +' ok, '+failed.length+' fail');
 if(failed.length){
  console.log('[diagnose] проблемные шаги: '+failed.map(r=>r.label).join(', '));
  console.log('[diagnose] подсказка: если «открытие X» падает с net::ERR_*/timeout — X не отвечает с этого компьютера. Проверьте VPN/прокси: https://x.com/home должен открываться в обычном браузере, либо задайте прокси в x_accounts.proxy_json.');
  process.exitCode=1;
 }
}
main().catch(()=>{console.error('[diagnose] unable to start: run from x-collector with dependencies installed');process.exitCode=1;});
