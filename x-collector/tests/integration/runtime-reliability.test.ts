import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Pool } from "pg";
import { chromium } from "playwright";
import { REQUIRED } from "../../lib/trade/migrations";
import { getPool, closePool, q } from "../../lib/trade/pg";
import { enqueueTask, claimTasks, finishTask, extendLease, failTask, QueueBackpressureError } from "../../lib/trade/tasks";
import { pickAccount, releaseAccount, extendAccountLease } from "../../lib/trade/account-manager";
import { persistTweets } from "../../lib/trade/collector-store";
import { clearKeyCache, encryptBuffer } from "../../lib/trade/crypto";
import { WorkerRegistry } from "../../lib/trade/worker-registry";
import { WorkerRuntime } from "../../src/runtime/worker-runtime";
import { executeTask } from "../../src/runtime/collector-task";
import { spawn } from "node:child_process";

test("real PostgreSQL: migration replay, parallel leases, restart fencing, transactional results and worker/browser fixture", {
  skip: !process.env.RUNTIME_TEST_DATABASE_URL,
  timeout: 120000,
}, async () => {
  const url = new URL(process.env.RUNTIME_TEST_DATABASE_URL!);
  assert(url.pathname.endsWith("_test"), "Requires an explicitly dedicated *_test database");
  const schema = "runtime_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-test-"));
  const prior = { DATABASE_URL:process.env.DATABASE_URL, MASTER_KEY:process.env.MASTER_KEY,
    ARCHIVE_RAW_DIR:process.env.ARCHIVE_RAW_DIR, ARCHIVE_MIN_FREE_GB:process.env.ARCHIVE_MIN_FREE_GB, X_LOGIN_BROWSER:process.env.X_LOGIN_BROWSER };
  let created = false;
  let launchMock: ReturnType<typeof mock.method> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    url.searchParams.set("options", "-c search_path=" + schema + ",public");
    process.env.DATABASE_URL = url.toString(); process.env.MASTER_KEY = "ab".repeat(32); clearKeyCache();
    process.env.ARCHIVE_RAW_DIR = root; process.env.ARCHIVE_MIN_FREE_GB = "0"; process.env.X_LOGIN_BROWSER = "chromium";
    for (const name of REQUIRED) await getPool().query(await fs.readFile("migrations/"+name,"utf8"));
    // Repeat additive migrations on the same populated schema.
    for (const name of ["015_collector_observations.sql","016_collector_task_results.sql","017_collector_live.sql"])
      await getPool().query(await fs.readFile("migrations/"+name,"utf8"));
    const ids = await Promise.all(Array.from({length:8},(_,n)=>enqueueTask({kind:"profile",payload:{handle:"user"+n}})));
    const claims = await Promise.all([claimTasks("a",4,60000),claimTasks("b",4,60000)]);
    const flat=claims.flat(); assert.equal(flat.length,8); assert.equal(new Set(flat.map(t=>t.id)).size,8);
    for(const task of flat) assert.equal(await finishTask(task.id,task.claimedBy,task.attempts),true);
    assert.equal(ids.filter(Boolean).length,8);
    const oldCap=process.env.COLLECTOR_MAX_BACKLOG;
    try {
      process.env.COLLECTOR_MAX_BACKLOG="1";
      const capacity=await Promise.allSettled([enqueueTask({kind:"profile",payload:{handle:"cap_a"}}),enqueueTask({kind:"profile",payload:{handle:"cap_b"}})]);
      assert.equal(capacity.filter(r=>r.status==='fulfilled').length,1);
      const rejected=capacity.find(r=>r.status==='rejected'); assert(rejected?.status==='rejected' && rejected.reason instanceof QueueBackpressureError);
      const [capped]=await claimTasks('cap',1,60000); await finishTask(capped.id,'cap');
    } finally { if(oldCap===undefined)delete process.env.COLLECTOR_MAX_BACKLOG;else process.env.COLLECTOR_MAX_BACKLOG=oldCap; }
    await getPool().query("INSERT INTO x_accounts(name,session_encrypted,hour_window_start,created_at,updated_at) VALUES('fixture',$1,0,0,0)",[encryptBuffer(Buffer.from('{"cookies":[],"origins":[]}'))]);
    const accounts=await Promise.all([pickAccount("profile","owner-a"),pickAccount("profile","owner-b")]);
    assert.equal(accounts.filter(Boolean).length,1);
    const owner=accounts[0]?"owner-a":"owner-b";
    assert.equal(await releaseAccount("fixture","wrong-owner"),false);
    await getPool().query("UPDATE x_accounts SET account_busy_until=0 WHERE name='fixture'");
    assert.equal(await extendAccountLease("fixture",owner,60000),false);
    await pickAccount("profile","new-owner");
    assert.equal(await releaseAccount("fixture",owner),false);
    assert.equal(await releaseAccount("fixture","new-owner"),true);
    await getPool().query("INSERT INTO x_accounts(name,session_encrypted,hour_window_start,created_at,updated_at) VALUES('cap-second',$1,0,0,0)",[encryptBuffer(Buffer.from('{"cookies":[],"origins":[]}'))]);
    await getPool().query('UPDATE xc_discovery_plan SET enabled=true,max_browser_accounts=1');
    const cappedAccounts=await Promise.all([pickAccount('profile','cap-a'),pickAccount('profile','cap-b')]);
    assert.equal(cappedAccounts.filter(Boolean).length,1,'Global browser cap serializes different accounts across concurrent callers');
    const cappedIndex=cappedAccounts.findIndex(Boolean);
    assert.equal(await releaseAccount(cappedAccounts[cappedIndex]!.name,cappedIndex===0?'cap-a':'cap-b'),true);
    await getPool().query('UPDATE xc_discovery_plan SET enabled=false');
    await getPool().query("DELETE FROM x_accounts WHERE name='cap-second'");

    await enqueueTask({kind:"search",payload:{query:"restart"},maxAttempts:3});
    const [old]=await claimTasks("same-name",1,60000);
    await getPool().query("UPDATE x_tasks SET lease_expires_at=0 WHERE id=$1",[old.id]);
    await closePool(); // new pool models process reconnection, task state persists.
    assert.equal(await extendLease(old.id,"same-name",60000,old.attempts),false);
    const [fresh]=await claimTasks("same-name",1,60000);
    assert.equal(await finishTask(old.id,"same-name",old.attempts),false);
    assert.equal(await failTask(fresh.id,"same-name",'schema: invalid payload',fresh.attempts),"dlq");
    assert.equal((await q("SELECT 1 FROM x_tasks_dlq WHERE original_id=$1",[fresh.id])).length,1);

    const tweet={id:"1234567890123456789",text:"$SOL @alice",authorHandle:"alice",authorDisplayName:null,
      url:"https://x.com/alice/status/1234567890123456789",views:null,likes:1,retweets:null,replies:0,
      isVerified:false,postedAt:Date.parse("2025-01-01"),observedAt:Date.parse("2025-01-02")};
    // Entity FK must see the outer uncommitted tweet; no nested connection allowed.
    const rawEnvelope = { endpoint: "SearchTimeline", queryId: "fixture-query",\n      variables: { rawQuery: "$SOL", cursor: "fixture-cursor" },\n      response: { data: { search_by_raw_query: { meta: { next_cursor: "fixture-cursor" } } }, errors: [] } };\n    await persistTweets(null,[tweet],null,undefined,undefined,undefined,{rawResponse:rawEnvelope});\n    const archivedRaw = (await q<{path:string}>("SELECT path FROM archive_raw_pages ORDER BY received_at DESC LIMIT 1"))[0];\n    assert(archivedRaw, "raw archive metadata should be committed with the tweet page");\n    const archivedPayload = JSON.parse(gunzipSync(await fs.readFile(archivedRaw.path)).toString("utf8")) as {capture_format_version:number;source_response?:unknown};\n    assert.equal(archivedPayload.capture_format_version,1);\n    assert.deepEqual(archivedPayload.source_response,rawEnvelope);\n    await persistTweets(null,[tweet]);\n    assert.equal((await q("SELECT 1 FROM twitter_tweets")).length,1);
    assert.equal((await q("SELECT 1 FROM tweet_entities WHERE tweet_id=$1",[tweet.id])).length,2);
    assert.equal((await q("SELECT 1 FROM twitter_tweet_observations")).length,1);
    await getPool().query(`CREATE FUNCTION reject_fixture_entity() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture entity failure'; END $$ LANGUAGE plpgsql`);
    await getPool().query(`CREATE TRIGGER reject_fixture BEFORE INSERT ON tweet_entities FOR EACH ROW EXECUTE FUNCTION reject_fixture_entity()`);
    const bad={...tweet,id:"2234567890123456789"};
    await assert.rejects(persistTweets(null,[bad]),/fixture entity failure/);
    assert.equal((await q("SELECT 1 FROM twitter_tweets WHERE tweet_id=$1",[bad.id])).length,0);
    assert.equal((await q("SELECT 1 FROM ip_raw_events WHERE external_id=$1",[bad.id])).length,0);
    await getPool().query("DROP TRIGGER reject_fixture ON tweet_entities");

    // Real handler -> real Playwright -> fixture page -> real PostgreSQL.
    const launch=chromium.launch.bind(chromium);
    let httpStatus=200;
    launchMock=mock.method(chromium,"launch",async (options: Parameters<typeof chromium.launch>[0])=>{
      const browser=await launch({...options,headless:true});
      const newContext=browser.newContext.bind(browser);
      mock.method(browser,"newContext",async (contextOptions: Parameters<typeof browser.newContext>[0])=>{
        const context=await newContext(contextOptions);
        const newPage=context.newPage.bind(context);
        mock.method(context,"newPage",async()=>{
          const page=await newPage();
          await page.route("https://x.com/**",route=>route.fulfill({status:httpStatus,contentType:"text/html",headers:{'retry-after':'120'},
            body:route.request().url().includes('/search')
              ? '<article data-testid="tweet"><a href="/alice/status/4234567890123456789"><time datetime="2025-01-01T00:00:00Z"></time></a><div data-testid="tweetText">fixture tweet</div></article>'
              : '<div data-testid="UserName"><span>Alice</span></div><div data-testid="UserDescription">Fixture profile</div><a href="/alice/followers">42 Followers</a>'}));
          return page;
        });
        return context;
      });
      return browser;
    });
    await enqueueTask({kind:"profile",payload:{handle:"alice"}});
    const [profile]=await claimTasks("fixture-worker",1,60000);
    const registry=new WorkerRegistry("fixture-worker"); await registry.register();
    const runtime=new WorkerRuntime("fixture-worker"); runtime.ready();
    assert.equal(await runtime.runJob(profile,task=>executeTask(task,{workerId:"fixture-worker",registry,
      signal:new AbortController().signal,isStopping:()=>false,useSourceCollector:false})),"done");
    assert.equal((await q<{followers:string}>("SELECT followers FROM twitter_profiles WHERE handle='alice'"))[0].followers,"42");
    assert.equal((await q<{status:string}>("SELECT status FROM x_tasks WHERE id=$1",[profile.id]))[0].status,"done");
    for(const status of [429,503,401]) {
      httpStatus=status;
      await getPool().query("UPDATE x_accounts SET status='active',account_busy_until=0,cooldown_until=0 WHERE name='fixture'");
      await enqueueTask({kind:'profile',payload:{handle:'http'+status},maxAttempts:3});
      const [task]=await claimTasks('fixture-worker',1,60000);
      const before=Date.now();
      assert.equal(await runtime.runJob(task,t=>executeTask(t,{workerId:'fixture-worker',registry,
        signal:new AbortController().signal,isStopping:()=>false,useSourceCollector:false})), 'failed');
      const stored=(await q<{status:string;available_at:string}>('SELECT status,available_at FROM x_tasks WHERE id=$1',[task.id]))[0];
      assert.equal(stored.status,'pending');
      if(status===429)assert(Number(stored.available_at)>=before+120000);
      const accountState=(await q<{status:string}>("SELECT status FROM x_accounts WHERE name='fixture'"))[0].status;
      assert.equal(accountState,status===429?'cooldown':status===401?'captcha':'active');
    }
    httpStatus=200;
    const cookies=['auth_token','ct0'].map(name=>({name,value:'fixture',domain:'.x.com',path:'/',expires:Date.now()/1000+3600,httpOnly:true,secure:true,sameSite:'Lax'}));
    await getPool().query("UPDATE x_accounts SET status='active',account_busy_until=0,cooldown_until=0,session_encrypted=$1 WHERE name='fixture'",[encryptBuffer(Buffer.from(JSON.stringify({cookies,origins:[]})))]);
    const sourceId=await enqueueTask({kind:'search',payload:{query:'fixture source',limit:1,sort:'latest'},priority:100});
    const [sourceTask]=await claimTasks('fixture-worker',1,60000);
    assert.equal(String(sourceTask.id),String(sourceId));
    assert.equal(await runtime.runJob(sourceTask,t=>executeTask(t,{workerId:'fixture-worker',registry,
      signal:new AbortController().signal,isStopping:()=>false,useSourceCollector:true})), 'done');
    assert.equal((await q("SELECT 1 FROM x_task_tweets WHERE task_id=$1",[sourceTask.id])).length,1);
    await runtime.stop(); await registry.stop();
    // Exercise every initial scheduler tick with only five real DB connections.
    const scheduler = spawn(process.execPath,['--import','tsx','scripts/scheduler.ts'],{
      env:{...process.env,PG_POOL_MAX:'5',SCHEDULER_CONCURRENCY:'2'},stdio:['ignore','pipe','pipe','ipc'],
    });
    let schedulerLog='';
    scheduler.stdout!.on('data',data=>{schedulerLog+=String(data);});
    scheduler.stderr!.on('data',data=>{schedulerLog+=String(data);});
    const exited=new Promise<number|null>((resolve,reject)=>{scheduler.once('exit',resolve);scheduler.once('error',reject);});
    try {
      const deadline=Date.now()+20000;
      let expected=0,completed=0;
      while(Date.now()<deadline) {
        expected=Number(schedulerLog.match(/scheduler started.*"tasks":(\d+)/)?.[1]??0);
        completed=(schedulerLog.match(/tick (done|failed|skipped)/g)??[]).length;
        if(expected>0&&completed>=expected)break;
        if(scheduler.exitCode!==null)break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert(expected>0&&completed>=expected,schedulerLog);
      assert(!/timeout exceeded when trying to connect|integer out of range/.test(schedulerLog),schedulerLog);
    } finally {
      const hardStop=setTimeout(()=>scheduler.kill('SIGKILL'),10000);
      if(scheduler.connected)scheduler.send({stop:true});else scheduler.kill('SIGTERM');
      const code=await exited;
      clearTimeout(hardStop);
      assert.equal(code,0,schedulerLog);
    }
  } finally {
    launchMock?.mock.restore();
    await closePool(); clearKeyCache();
    if(created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end(); await fs.rm(root,{recursive:true,force:true});
    for(const [key,value] of Object.entries(prior)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
  }
});
