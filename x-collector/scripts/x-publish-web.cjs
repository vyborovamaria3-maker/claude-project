const fs=require('node:fs'),path=require('node:path'),nodeCrypto=require('node:crypto');
const {Client}=require('pg'),{chromium}=require('playwright'),dotenv=require('dotenv');
const {launchLoginBrowser}=require('./test-publish-browser.cjs');
const {parseProxy}=require('./x-proxy.cjs');
async function main(){
 const {name,expected,text}=await new Promise(resolve=>process.once('message',resolve));
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(name||'')||!/^@?[A-Za-z0-9_]{1,15}$/.test(expected||''))throw Error('Usage: node scripts/test-publish.cjs SESSION_NAME EXPECTED_USERNAME');
 const handle=expected.replace(/^@/,'').toLowerCase();
 const env=dotenv.parse(fs.readFileSync(process.env.X_COLLECTOR_ENV?path.resolve(process.env.X_COLLECTOR_ENV):path.resolve('.env')));
 const client=new Client({connectionString:env.DATABASE_URL||process.env.X_COLLECTOR_DATABASE_URL,connectionTimeoutMillis:5000});
 let browser,key,plain;let attempted=false;
 try{
 await client.connect();
 const row=(await client.query('SELECT role,status,session_encrypted,proxy_json,user_agent,timezone,language FROM x_accounts WHERE name=$1',[name])).rows[0];
 if(!row||row.role!=='publisher'||row.status!=='active')throw Error('Account must exist, be active, and have publisher role.');
 const proxy=parseProxy(row.proxy_json);if(row.proxy_json&&!proxy)throw Error('PROXY_FAILED: invalid account proxy');
 const raw=env.MASTER_KEY||process.env.X_COLLECTOR_MASTER_KEY||'';
 key=/^[a-f0-9]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');
 if(key.length!==32)throw Error('Invalid MASTER_KEY.');
 const encrypted=row.session_encrypted;
 if(!Buffer.isBuffer(encrypted)||encrypted.length<29)throw Error('Invalid encrypted session.');
 const decipher=nodeCrypto.createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));decipher.setAuthTag(encrypted.subarray(12,28));
 plain=Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]);
 const state=JSON.parse(plain.toString('utf8'));
 const opened=await launchLoginBrowser(chromium,{...process.env,X_LOGIN_BROWSER:env.X_LOGIN_BROWSER||process.env.X_LOGIN_BROWSER},{proxy});browser=opened.browser;
 const context=await browser.newContext({storageState:state,userAgent:row.user_agent||undefined,timezoneId:row.timezone||undefined,locale:row.language||undefined});plain.fill(0);key.fill(0);
 const page=await context.newPage();await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:45000});
 const profile=page.locator('[data-testid="AppTabBar_Profile_Link"]').first();await profile.waitFor({timeout:30000});
 const href=await profile.getAttribute('href');
 if(href?.replace(/^\//,'').toLowerCase()!==handle)throw Error('Logged-in account does not match expected username. Nothing posted.');
 await page.goto('https://x.com/compose/post',{waitUntil:'domcontentloaded',timeout:45000});
 if(typeof text!=='string'||!text.trim()||Array.from(text).length>280)throw Error('Invalid text.');
 await page.locator('[data-testid="tweetTextarea_0"]').first().fill(text,{timeout:30000});
 const button=page.locator('[data-testid="tweetButton"]').first();await button.waitFor({timeout:20000});
 const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&/\/CreateTweet(?:\?|$)/.test(new URL(r.url()).pathname),{timeout:45000}).then(async r=>({ok:r.ok(),body:await r.json()})).catch(()=>null);
 process.send?.({status:'sending',message:'Отправляем твит…'});attempted=true;await button.click({timeout:15000});
 const response=await responsePromise;
 const id=response?.body?.data?.create_tweet?.tweet_results?.result?.rest_id;
 if(!response?.ok||!/^\d+$/.test(id||''))throw Error('Publication not confirmed. Check the profile before running again; the tweet may already exist.');
 process.send?.({status:'done',message:'Твит опубликован',url:'https://x.com/'+handle+'/status/'+id});
 }catch(_e){
 if(attempted)console.error('Do not retry automatically: check the X profile first.');
 // Never print raw database, decryption, or browser errors: they may contain secrets.
 const msg=_e.message||'';const unreachable=!attempted&&!/^(Usage:|Account must|Invalid|Logged-in account|Invalid text)/.test(msg)&&/net::ERR_|Timeout \d+ms exceeded|Target page, context or browser has been closed|frame was detached/i.test(msg);
 process.send?.({status:attempted?'uncertain':'failed',message:attempted?'Результат отправки неизвестен. Проверьте профиль X перед повтором.':unreachable?'X не отвечает с этого компьютера. Проверьте сеть/VPN либо задайте прокси для аккаунта (proxy_json).':'Не удалось отправить. Проверьте имя профиля, сессию и настройки X Collector.'});process.exitCode=1;
 }finally{plain?.fill(0);key?.fill(0);await browser?.close().catch(()=>{});await client.end().catch(()=>{});if(process.connected)process.disconnect();}
}
main().catch(()=>{process.send?.({status:'failed',message:'Не удалось запустить публикацию'});if(process.connected)process.disconnect();process.exitCode=1;});
process.on('disconnect',()=>{process.exit();});
