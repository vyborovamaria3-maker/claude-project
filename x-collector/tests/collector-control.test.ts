import { CollectorActionError } from "../lib/collector/errors";
import { recordProgress,liveSnapshot,closeLive } from "../lib/collector/live";
import { WorkerRegistry } from "../lib/trade/worker-registry";
import { test,mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { readiness,startCollection,taskDetails,resumeCollection } from '../lib/collector/control';
import { handleCollectorRequest } from '../lib/collector/http';
import { hasXSession } from '../lib/trade/x-session';
import { encryptBuffer,clearKeyCache } from '../lib/trade/crypto';
import { closePool } from '../lib/trade/pg';
import { claimTasks,finishTask,failTask } from '../lib/trade/tasks';
import { persistTweets,persistProfile } from '../lib/trade/collector-store';
import { collectArticles } from '../lib/trade/twitter-scraper';
import { registerAccount,pickAccount } from '../lib/trade/account-manager';
import { applySecurityHeaders } from '../lib/trade/http-security';
import { enforceBasicAuth } from '../lib/trade/http-auth';
const load=createRequire(__filename),bundled=load('@sparticuz/chromium').default as typeof import('@sparticuz/chromium').default;
test('X session readiness rejects missing, expired and unrelated cookies',()=>{
 assert.equal(hasXSession({cookies:[]}),false);
 assert.equal(hasXSession({cookies:[{name:'auth_token',value:'fixture',domain:'.example.com',expires:-1}]}),false);
 assert.equal(hasXSession({cookies:[{name:'auth_token',value:'fixture',domain:'.x.com',expires:1}]}),false);
 assert.equal(hasXSession({cookies:[{name:'auth_token',value:'fixture',domain:'.x.com',expires:-1}]}),true);
});
test('Start button reaches queue, real storage and task results; retries and setup errors remain visible',async()=>{
 const db=new PGlite(),root=await fs.mkdtemp(path.join(os.tmpdir(),'collector-control-'));
 const names=['DATABASE_URL','MASTER_KEY','ARCHIVE_RAW_DIR','ARCHIVE_MIN_FREE_GB','PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH','COLLECTOR_AUTOSTART'];const old=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 process.env.DATABASE_URL='postgresql://fixture/collector_control_test';process.env.MASTER_KEY='12'.repeat(32);clearKeyCache();process.env.ARCHIVE_RAW_DIR=root;process.env.ARCHIVE_MIN_FREE_GB='0';process.env.COLLECTOR_AUTOSTART='true';
 
 const query=async(sql:string,params:unknown[]=[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};};
 const a=mock.method(Pool.prototype,'query',query),b=mock.method(Pool.prototype,'connect',async()=>({query,release(){},on(){}}));
 let launches=0;const startWorker=async()=>{launches++;};
 const services={readiness,taskDetails,resumeCollection:(id:string)=>resumeCollection(id,startWorker),startCollection:(input:unknown)=>startCollection(input,startWorker)};
 let origin='';const server=http.createServer(async(req,res)=>{applySecurityHeaders(res);if(!enforceBasicAuth(req,res,'fixture','fixture','collector'))return;await handleCollectorRequest(req,res,origin,services);});
 const browser = await chromium.launch({ headless: true });
 try{
 assert.equal((await readiness()).ready,false);
 for(const f of ['001_init.sql','014_archive.sql','018_ai_foundation.sql','015_collector_observations.sql','016_collector_task_results.sql','017_collector_live.sql','019_account_roles.sql','020_account_profile.sql','023_intelligence_platform.sql','024_intelligence_temporal.sql'])await db.exec(await fs.readFile('migrations/'+f,'utf8'));
 await db.exec('ALTER TABLE x_accounts ADD COLUMN IF NOT EXISTS account_claimed_by text');
 assert.equal((await readiness()).ready,false);
 const blob=encryptBuffer(Buffer.from(JSON.stringify({cookies:[{name:'auth_token',value:'controlled-fixture',domain:'.x.com',expires:-1}],origins:[]})));
 const invalid=encryptBuffer(Buffer.from(JSON.stringify({cookies:[],origins:[]})));
 for(let n=0;n<21;n++)await registerAccount('a'+String(n).padStart(2,'0'),invalid);
 assert.equal((await readiness()).ready,false);
 await registerAccount('fixture',blob);assert.equal((await readiness()).ready,true);
 await db.query("UPDATE x_accounts SET tier='retired' WHERE name LIKE 'a%'");
 await assert.rejects(startCollection({kind:'search',payload:{query:'fixture'},requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},async()=>{throw new Error('startup fixture failure');}),/startup fixture/);assert.equal((await db.query('SELECT * FROM x_tasks')).rows.length,0);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
 const context=await browser.newContext({httpCredentials:{username:'fixture',password:'fixture'}}),page=await context.newPage();
 await page.goto(origin+'/collector');await page.waitForFunction(()=>!(document.getElementById('start') as HTMLButtonElement).disabled);
 await page.locator('#value').fill('solana');
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/collector/start')),page.locator('#start').click()]);assert.equal(response.status(),202);const {id}=await response.json();assert.equal(launches,1);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/collector/resume')),page.locator('#resume').click()]);assert.equal(launches,2);
 const task=(await db.query<{idempotency_key:string;payload_json:unknown}>("SELECT * FROM x_tasks WHERE id=$1",[id])).rows[0];
 const retry={kind:'search',payload:task.payload_json,requestId:task.idempotency_key.slice(3)};
 assert.equal((await startCollection(retry,startWorker)).reused,true);assert.equal((await db.query('SELECT * FROM x_tasks')).rows.length,1);
 await assert.rejects(startCollection({...retry,payload:{query:'changed'}},startWorker),/requestId/);
 const csrf=await fetch(origin+'/api/collector/start',{method:'POST',headers:{Authorization:'Basic '+Buffer.from('fixture:fixture').toString('base64'),Origin:'https://evil.invalid'},body:JSON.stringify(retry)});assert.equal(csrf.status,403);
 const [claimed]=await claimTasks('controlled-worker',1,60000);assert.equal(Number(claimed.id),Number(id));
 await new WorkerRegistry('controlled-worker').register();
 await db.query('UPDATE x_tasks SET lease_expires_at=0 WHERE id=$1',[id]);assert.equal(await recordProgress(Number(id),'controlled-worker',claimed.attempts,{phase:'collecting',found:999}),false);await db.query('UPDATE x_tasks SET lease_expires_at=$2 WHERE id=$1',[id,Date.now()+60000]);
 assert.equal(await recordProgress(Number(id),'stale-worker',claimed.attempts,{phase:'collecting',found:999}),false);
 const fixture=await context.newPage();await fixture.setContent('<article data-testid="tweet"><a href="/alice/status/1234567890123456789"><time datetime="2025-01-01"></time></a><div data-testid="tweetText">Solana @bob</div><button data-testid="like" aria-label="4 Likes"></button></article>');
 await collectArticles(fixture,1,Date.now()+10000,async progress=>{assert(await recordProgress(Number(id),'controlled-worker',claimed.attempts,{...progress,account:'fixture',startedAt:Date.now()}));},async tweets=>{await persistTweets(null,tweets,null,Number(id));});
 assert.equal(Number((await liveSnapshot()).jobs.find(j=>String(j.id)===String(id))?.saved_tweets),1);
 await page.waitForFunction(()=>document.getElementById('live-jobs')?.textContent?.includes('1 постов'));
 assert.match(await page.locator('#live-jobs').innerText(),/alice/);assert.equal(await finishTask(Number(id),'controlled-worker'),true);
 await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('progress')?.textContent?.includes('Сбор завершён'));assert.equal(await page.locator('#tweets tr').count(),1);assert.match(await page.locator('#tweets').innerText(),/alice/);assert.match(await page.locator('#tweets').innerText(),/—/);
 const profile=await startCollection({kind:'profile',payload:{handle:'alice'},requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},startWorker);const [profileTask]=await claimTasks('controlled-worker',1,60000);
 await persistProfile({handle:'alice',displayName:'Alice',bio:'Solana',followers:10,following:null,postsCount:null,isVerified:false,joinedAt:null,avatarUrl:null},Number(profile.id));await finishTask(profileTask.id,'controlled-worker');assert.equal(Number((await taskDetails(String(profile.id)))!.counts!.profiles),1);
 const partial=await startCollection({kind:'timeline',payload:{handle:'alice',limit:5},requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},startWorker);
 const [partialTask]=await claimTasks('controlled-worker',1,60000);
 await assert.rejects(collectArticles(fixture,5,Date.now()+10000,undefined,async batch=>{await persistTweets(null,batch,null,Number(partial.id));throw new Error('controlled interruption');}),/controlled interruption/);
 assert.equal(Number((await taskDetails(String(partial.id)))!.counts!.tweets),1);
 assert.equal(await failTask(partialTask.id,'controlled-worker','controlled interruption'),'requeued');
 assert.equal(await recordProgress(Number(id),'controlled-worker',claimed.attempts,{phase:'collecting',found:999}),false);
 await db.query("UPDATE x_accounts SET status='captcha',cooldown_until=0");assert.equal((await readiness()).ready,false);assert.equal(await pickAccount('search','blocked-fixture'),null);
 await page.locator('#check').click();await page.waitForFunction(()=>(document.getElementById('start') as HTMLButtonElement).disabled);assert.match(await page.locator('#checks').innerText(),/CAPTCHA/);
 await db.query("UPDATE x_accounts SET health_score=0,last_check_at=1,last_check_json='{\"errorType\":\"SESSION_EXPIRED\"}' WHERE name='fixture'");
 await registerAccount('fixture',blob);
 const renewed=(await db.query<{health_score:null;last_check_json:null;last_check_at:null}>("SELECT health_score,last_check_json,last_check_at FROM x_accounts WHERE name='fixture'")).rows[0];
 assert.deepEqual(renewed,{health_score:null,last_check_json:null,last_check_at:null});
 assert(await pickAccount('profile','renewed-fixture'));
 await registerAccount('selected',blob);
 await db.query("UPDATE x_accounts SET account_busy_until=0 WHERE name='fixture'");
 assert.equal((await pickAccount('search','selected-fixture','selected'))?.name,'selected');
 assert.equal(await pickAccount('search','selected-busy','selected'),null);
 assert.equal(await pickAccount('search','unknown-selection','missing'),null);
 await db.query("UPDATE x_accounts SET account_busy_until=0,role='publisher' WHERE name='selected'");
 assert.equal(await pickAccount('search','publisher-selection','selected'),null);
 }finally{await browser.close();closeLive();await new Promise<void>(resolve=>server.close(()=>resolve()));await closePool();a.mock.restore();b.mock.restore();await db.close();await fs.rm(root,{recursive:true,force:true});clearKeyCache();for(const [n,v] of Object.entries(old)){if(v===undefined)delete process.env[n];else process.env[n]=v;}}
});

test('collector HTTP hides internal failures but preserves authored action errors',async()=>{
 let failure:Error=new Error('sensitive fixture session-token and private host');
 const services={readiness:async()=>{throw failure;},taskDetails,startCollection,resumeCollection};
 const server=http.createServer(async(req,res)=>{await handleCollectorRequest(req,res,'http://localhost',services);});
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/api/collector/status`;
  const internal=await fetch(url);assert.equal(internal.status,503);
  assert.doesNotMatch(await internal.text(),/sensitive|session-token|private host/);
  failure=new CollectorActionError('Установите браузер');
  const actionable=await fetch(url);assert.equal(actionable.status,409);assert.match(await actionable.text(),/Установите браузер/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


