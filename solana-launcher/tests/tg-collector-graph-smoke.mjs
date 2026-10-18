import assert from 'node:assert/strict';
import { chromium } from 'playwright';
// Synthetic Collector API only; never logs in to Telegram.
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();let release,requested=false;
 const pending=new Promise(resolve=>{release=resolve});
 await page.route('**/api/integrations/tg-collector**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('/session')) return route.fulfill({status:404,json:{error:'Manual fixture access'}});
  if(url.searchParams.get('mode')==='evidence'){
   const second=url.searchParams.get('targetKey')==='second';
   if(second){requested=true;await pending;}
   return route.fulfill({json:{evidence:[{identifier:'fixture_source',message_id:second?'11':'10',posted_at:null,text:second?'Second evidence':'First evidence'}]}});
  }
  if(url.pathname.endsWith('/graph')) return route.fulfill({json:{nodes:[{id:'s',label:'Fixture source',kind:'source'},...['first','second'].map(id=>({id,label:id+' target',kind:'telegram_username'}))],edges:['first','second'].map(id=>({id,from:'s',to:id,sourceId:'1',kind:'mention',targetKind:'telegram_username',targetKey:id,strength:1,sampleUrl:'https://t.me/fixture_source/10',lastSeen:null})),metrics:[],sharedAddresses:[],observedAddresses:[],sampled:false,days:90}});
  return route.fulfill({json:{configured:true,workerOnline:false,runtimeMetrics:{messages_total:2,messages_per_day:2,links_total:2,links_per_day:2,jobs_pending:0,jobs_failed:0,flood_wait_active:false},stats:{sources:1,messages:2,running:0,failed:0},sources:[],messages:[],page:0}});
 });
 await page.goto((process.env.TG_COLLECTOR_SMOKE_URL||'http://127.0.0.1:3171')+'/tg-collector',{waitUntil:'networkidle',timeout:120000});
 await page.waitForFunction(()=>{const input=document.querySelector('[aria-label="Ключ доступа TG Collector"]');return input&&Object.keys(input).some(key=>key.startsWith('__reactProps$'))});
 await page.getByLabel('Ключ доступа TG Collector').fill('local-browser-fixture-access-key');
 await page.getByRole('button',{name:'Открыть',exact:true}).click();
 await page.getByRole('button',{name:/Fixture source → first target/}).click();
 const first=page.getByRole('link',{name:/First evidence/});await first.waitFor();assert.equal(await first.getAttribute('href'),'https://t.me/fixture_source/10');
 await page.getByRole('button',{name:/Fixture source → second target/}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('Загрузка'));
 assert(requested);assert.equal(await first.count(),0,'Old evidence must disappear when selecting a new edge');
 release();const second=page.getByRole('link',{name:/Second evidence/});await second.waitFor();assert.equal(await second.getAttribute('href'),'https://t.me/fixture_source/11');
 console.log('PASS: graph selection, matching evidence, original post URL, stale-evidence regression. Synthetic API.');
}finally{await browser.close()}
