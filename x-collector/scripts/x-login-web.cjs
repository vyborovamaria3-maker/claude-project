// Visible, isolated browser login. Passwords and plaintext cookies stay out of files and IPC.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');const {launchLoginBrowser,attachLoginDiagnostics}=require('./login-browser.cjs');const {Client}=require('pg');const dotenv=require('dotenv');
const env=dotenv.parse(fs.readFileSync(process.env.X_COLLECTOR_ENV?path.resolve(process.env.X_COLLECTOR_ENV):path.resolve('.env')));
const [name,role]=process.argv.slice(2);
let browser,context,saving=false,ended=false;
function report(status,message){if(process.connected)process.send({status,message});}
async function close(){ended=true;await browser?.close().catch(()=>{});if(process.connected)process.disconnect();}
function encrypt(plain){const raw=env.MASTER_KEY||process.env.X_COLLECTOR_MASTER_KEY;if(!raw)throw Error('key');const key=/^[a-f0-9]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');if(key.length!==32)throw Error('key');try{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([c.update(plain,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]);}finally{key.fill(0);}}
async function finish(){if(saving||ended)return;saving=true;report('saving','Проверяем вход…');let client,encrypted;
try{
 const page=context.pages().find(p=>/https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//.test(p.url()));
 if(!page)throw Error('notlogged');
 await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForSelector('[data-testid="AppTabBar_Home_Link"]',{timeout:20000});
 const state=await context.storageState();const valid=c=>c.value&&(c.expires===-1||c.expires>Date.now()/1000)&&/^(?:\.)?(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com)$/i.test(c.domain);
 if(!['auth_token','ct0'].every(n=>state.cookies.some(c=>c.name===n&&valid(c))))throw Error('notlogged');
 state.cookies=state.cookies.filter(c=>/^(?:\.)?(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com)$/i.test(c.domain));
 const profile=await page.locator('[data-testid="AppTabBar_Profile_Link"]').first().getAttribute('href').catch(()=>null);
 const handle=profile&&/^\/[A-Za-z0-9_]{1,15}$/.test(profile)?profile.slice(1).toLowerCase():null;
 encrypted=encrypt(JSON.stringify(state));
 client=new Client({connectionString:env.DATABASE_URL||process.env.X_COLLECTOR_DATABASE_URL,connectionTimeoutMillis:5000});await client.connect();
 const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='x_accounts' AND column_name IN ('role','publisher_handle')")).rows.map(r=>r.column_name);
 if(role==='publisher'&&!columns.includes('role'))throw Error('role');
 const cols=['name','session_encrypted','tier','status','weight_quota_per_hour','hour_window_start','created_at','updated_at'];const values=[name,encrypted,'new','active',15,Date.now(),Date.now(),Date.now()];
 if(columns.includes('role')){cols.push('role');values.push(role);}
 if(role==='publisher'&&handle&&columns.includes('publisher_handle')){cols.push('publisher_handle');values.push(handle);}
 await client.query(`INSERT INTO x_accounts (${cols.join(',')}) VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')})`,values);
 report('done','Вход выполнен. Аккаунт добавлен в выбранную группу.');await close();
}catch(error){
 if(error.message==='notlogged'||error.name==='TimeoutError'){saving=false;report('waiting','Вход ещё не завершён. Пройдите проверку X, дождитесь главной ленты и нажмите «Сохранить вход» снова.');}
 else {report('failed',error.code==='23505'?'Имя сессии или профиль уже зарегистрированы. Выберите другое имя.':error.message==='role'?'Сначала установите поддержку ролей аккаунтов.':'Не удалось сохранить сессию. Проверьте MASTER_KEY, базу и миграции.');await close();}
}finally{encrypted?.fill(0);await client?.end().catch(()=>{});}}
process.on('message',message=>{if(message?.action==='finish')void finish();});process.on('disconnect',()=>{if(!ended)void close();});process.on('SIGTERM',()=>void close());
(async()=>{try{
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(name||'')||!['collector','publisher'].includes(role)||!(env.DATABASE_URL||process.env.X_COLLECTOR_DATABASE_URL)||!(env.MASTER_KEY||process.env.X_COLLECTOR_MASTER_KEY))throw Error('config');
 const opened=await launchLoginBrowser(chromium,{...process.env,X_LOGIN_BROWSER:env.X_LOGIN_BROWSER||process.env.X_LOGIN_BROWSER});
 browser=opened.browser;if(ended){await browser.close();return;}browser.on('disconnected',()=>{if(!ended){report('failed','Окно браузера закрыто. Начните вход заново.');void close();}});
 context=await browser.newContext();const page=await context.newPage();attachLoginDiagnostics(page,message=>{if(!saving&&!ended)report('waiting',opened.label+': '+message);});await page.goto('https://x.com/i/flow/login',{waitUntil:'domcontentloaded',timeout:30000});report('waiting',opened.label+': Войдите в X в открывшемся окне. Затем нажмите «Сохранить вход» на сайте.');
}catch(error){report('failed',error.message==='config'?'Настройте DATABASE_URL и MASTER_KEY в x-collector/.env.':error.message==='browserconfig'?'X_LOGIN_BROWSER: используйте chrome, msedge или chromium.':'Не удалось открыть браузер. Установите Chrome/Edge либо выполните npx.cmd playwright install chromium в x-collector.');await close();}})();
