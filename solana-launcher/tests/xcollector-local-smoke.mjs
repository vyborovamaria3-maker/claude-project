// Run against an isolated local development server; every browser API call is mocked.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../x-collector/package.json',import.meta.url));
const {chromium}=require('playwright');
const base=process.env.X_COLLECTOR_SMOKE_URL||'http://127.0.0.1:3310';
assert.equal(new URL(base).hostname,'127.0.0.1');
const browser=await chromium.launch({headless:true});
let passed=0;
const check=message=>{passed++;console.log('PASS '+message);};
try{
 const context=await browser.newContext(),page=await context.newPage();
 page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let outage=true,state='idle',statsOutage=true;
 const now=String(Date.now());
 const overview=()=>({providers:[],configs:[],accounts:[],control:{paused:true,heartbeat:now},
  workerHealth:{state,heartbeat_at:now,started_at:now,components:[],queue:{queued:1,running:1,uncertain:1,manual_review:1,oldest_queued_at:now}},
  breakers:[{kind:'account',subject:'offline_fixture',state:'open',consecutive_failures:3,reason_code:'X_RESTRICTED',resume_at:now},
   {kind:'ai',subject:'mock_ai',state:'half_open',consecutive_failures:3,reason_code:'AI_FAILED',resume_at:now}],
  jobs:['queued','running','uncertain','published','failed'].map((status,i)=>({id:'fixture-'+i,account_name:'offline_fixture',kind:'post',content:'offline '+status,status,reason:'Test fixture',message:'mock only',scheduled_at:now})),reconciliation:[],sources:{count:0,latest:null},lists:[]});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==base){await route.abort();return;}
  if(!url.pathname.startsWith('/api/')){await route.continue();return;}
  if(url.pathname!=='/api/integrations/x-collector'){await route.fulfill({json:{}});return;}
  assert.equal(route.request().method(),'GET','No mutations are needed for UI acceptance');
  const action=url.searchParams.get('action');
  if(action==='autopost-overview'){
   await route.fulfill(outage?{status:503,json:{error:'offline fixture API unavailable'}}:{json:overview()});return;
  }
  if(action==='accounts'){await route.fulfill({json:{rolesSupported:true,accounts:[{name:'offline_fixture',role:'publisher',status:'active',tier:'standard',updated_at:now,account_busy_until:'0',weight_used_this_hour:0,weight_quota_per_hour:100,total_requests:'0',total_errors:'0',proxy:null}]}});return;}
  if(action==='publisher-stats'){await route.fulfill({json:{account:{name:'offline_fixture',publisher_handle:'offline_fixture'},needsHandle:false,summary:{posts:1,views:'123',likes:null,replies:'0',retweets:'0',last_updated:now},series:[],posts:[],page:1,pageSize:20,days:30}});return;}
  if(action==='autopost-stats'){
   await route.fulfill(statsOutage?{status:503,json:{error:'offline fixture metrics unavailable'}}:{json:{posts:[{tweet_id:'123456',text:'Offline metric fixture',url:'https://x.com/offline_fixture/status/123456',views:null,likes:'0',replies:null,retweets:'0',updated_at:now}],snapshots:[],sync:[]}});return;
  }
  if(action==='autopost-audit'){await route.fulfill({json:{job:{id:'fixture-0',account_name:'offline_fixture',kind:'post',status:'queued'},attempts:[],events:[]}});return;}
  await route.fulfill({json:{installed:true,dirExists:true,nodeModulesPresent:true,env:{databaseUrlConfigured:true,masterKeyConfigured:true},migrations:{complete:true,missing:[],path:'test'},processes:{worker:null,scheduler:null,dashboard:null},health:{worker:{reachable:false,detail:'test'},dashboard:{reachable:false,detail:'test'}},db:{reachable:true,detail:'test'}}});
 });
 async function open(){
  try{
   await page.goto(base+'/settings',{waitUntil:'load',timeout:180000});
   await page.waitForFunction(()=>{
    const button=document.querySelector('[data-tag="settings.tab.xcollector"]')?.closest('button');
    return button&&Object.keys(button).some(key=>key.startsWith('__reactProps$')&&typeof button[key]?.onClick==='function');
   });
   await page.locator('[data-tag="settings.tab.xcollector"]').click();
   await page.getByRole('heading',{name:'X Collector',exact:true}).waitFor();
   await page.getByRole('button',{name:'Автопостинг',exact:true}).click();
   await page.getByRole('heading',{name:'Автопостинг и активность X'}).waitFor();
  }catch(e){console.log('Browser errors:',errors);console.log((await page.locator('body').innerText()).slice(-5000));throw e;}
 }
 await open();await page.getByRole('alert').filter({hasText:'offline fixture API unavailable'}).waitFor();
 const agent=page.locator('div.rounded-xl').filter({has:page.locator('p',{hasText:/^Агент$/})});
 assert.match(await agent.innerText(),/Нет данных/);check('API outage leaves agent status unknown');
 assert.equal(await page.getByText('Неопределённых отправок нет.',{exact:true}).count(),0);check('API outage does not claim an empty reconciliation queue');
 outage=false;await open();await page.getByText('Работает · ожидание',{exact:true}).first().waitFor();check('settings recover after API recovery');
 for(const status of ['В очереди','Выполняется','Проверьте X','Выполнено','Ошибка до отправки'])await page.getByRole('cell',{name:status+' mock only',exact:false}).waitFor();check('all five queue states render');
 await page.getByText('ИИ-провайдер:',{exact:false}).waitFor();await page.getByText('Проверка восстановления',{exact:false}).waitFor();
 for(const button of await page.getByRole('button',{name:'Сбросить паузу после проверки'}).all())assert.equal(await button.isDisabled(),true);check('open and half_open breakers require explicit checked acknowledgement');
 await page.getByRole('button',{name:'Журнал',exact:true}).first().click();await page.getByRole('heading',{name:'Журнал задания · offline_fixture / post'}).waitFor();check('audit opens without sending X actions');
 for(state of ['busy','stalled','offline']){await open();await page.getByText({busy:'Работает · занят',stalled:'Задача выполняется слишком долго',offline:'Не работает'}[state],{exact:true}).first().waitFor();console.log('Worker '+state+' verified');}check('busy, stalled and offline Worker states survive reload');
 if(process.env.X_COLLECTOR_SMOKE_SCREENSHOT)await page.screenshot({path:process.env.X_COLLECTOR_SMOKE_SCREENSHOT,fullPage:true});
 await page.clock.install();
 await page.getByRole('button',{name:'Аккаунты',exact:true}).click();
 await page.getByRole('button',{name:'Статистика',exact:true}).click();
 const stats=page.getByRole('region',{name:'Статистика offline_fixture',exact:true});
 await stats.getByText('123',{exact:true}).waitFor();await stats.getByRole('img',{name:'Просмотры постов',exact:true}).waitFor();check('publisher statistics and charts render');
 await stats.getByText('offline fixture metrics unavailable',{exact:true}).waitFor();
 statsOutage=false;await page.clock.fastForward(16000);
 await stats.getByText('Offline metric fixture',{exact:true}).waitFor();
 assert.equal(await stats.getByText('offline fixture metrics unavailable',{exact:true}).count(),0);check('metric API errors clear on successful polling recovery');
 assert.ok(await stats.getByRole('cell',{name:'Нет данных',exact:true}).count()>=2);check('unknown metrics remain unknown rather than zero');
 assert.deepEqual(errors,[]);check('no browser runtime errors');
 console.log(JSON.stringify({passed,failed:0,realXRequests:0}));
}finally{await browser.close();}
