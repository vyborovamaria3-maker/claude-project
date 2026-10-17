import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createHash, randomUUID } from "node:crypto";
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
    for (const name of ["015_collector_observations.sql","016_collector_task_results.sql","017_collector_live.sql","048_signal_registry_versions.sql","049_raw_retention_author_id.sql"])
      await getPool().query(await fs.readFile("migrations/"+name,"utf8"));
    await getPool().query("SELECT capture_signal_history()");
    const qualityMints = ["quality-ready-" + randomUUID(), "quality-missing-" + randomUUID()];
    const qualitySignalAt = Math.floor(Date.now() / 86400000) * 86400000 - 6 * 3600000;
    const qualityAuthorHandle = "quality-author-" + randomUUID();
    const qualityAuthorTweetId = "quality-author-tweet-" + randomUUID();
    try {
      const registry = await getPool().query("SELECT version FROM signal_registry WHERE signal_key='entity'");
      assert.deepEqual(registry.rows.map(row => Number(row.version)), [1]);
      const threshold = await getPool().query("SELECT threshold::text FROM signal_thresholds WHERE signal_key='entity' AND signal_version=1 AND is_default");
      assert.equal(Number(threshold.rows[0]?.threshold), 60);
      await getPool().query("INSERT INTO signal_history(source,mint,signal_at,score,details) VALUES ($1,$2,$3,80,'{}'::jsonb),($1,$4,$5,70,'{}'::jsonb)",
        ["entity", qualityMints[0], qualitySignalAt, qualityMints[1], qualitySignalAt + 5 * 60000]);
      await getPool().query(
        "INSERT INTO signal_registry(signal_key,version,display_name,definition) VALUES('entity',2,'Entity signal v2','{}'::jsonb)",
      );
      await getPool().query(
        "INSERT INTO signal_thresholds(signal_key,signal_version,threshold_version,threshold,is_default,effective_from) VALUES('entity',2,1,65,TRUE,0)",
      );
      await getPool().query(
        "INSERT INTO signal_history(source,signal_version,mint,signal_at,score,details) VALUES('entity',2,$1,$2,75,'{}'::jsonb)",
        [qualityMints[0], qualitySignalAt],
      );
      await getPool().query("INSERT INTO mint_attention_snapshots(mint,observed_at,tweets,authors,views,likes,retweets) VALUES ($1,$2,10,3,1000,50,10),($1,$3,12,4,1500,70,15)",
        [qualityMints[0], qualitySignalAt - 5 * 60000, qualitySignalAt + 65 * 60000]);
      const refreshed = await getPool().query("SELECT refresh_signal_quality_outcomes($1,$2,$3::integer[]) AS refreshed",
        [qualitySignalAt - 1, qualitySignalAt + 5 * 60000 + 1, [1]]);
      assert(Number(refreshed.rows[0]?.refreshed) >= 3, "quality refresh should evaluate all signal versions");
      const outcomes = await getPool().query("SELECT mint,outcome_status,attention_change_pct::text,signal_version,baseline_window_start::text,baseline_window_end::text,outcome_window_start::text,outcome_window_end::text FROM signal_quality_outcomes WHERE mint = ANY($1::text[]) AND signal_version=1 ORDER BY mint", [qualityMints]);
      assert.equal(outcomes.rows.length, 2);
      const ready = outcomes.rows.find(row => row.mint === qualityMints[0]);
      const missing = outcomes.rows.find(row => row.mint === qualityMints[1]);
      assert.equal(ready?.outcome_status, "ready");
      assert.equal(Number(ready?.attention_change_pct), 50);
      assert.equal(Number(ready?.signal_version), 1);
      assert.equal(Number(ready?.baseline_window_start), qualitySignalAt - 3600000);
      assert.equal(Number(ready?.baseline_window_end), qualitySignalAt);
      assert.equal(Number(ready?.outcome_window_start), qualitySignalAt + 3600000);
      assert.equal(Number(ready?.outcome_window_end), qualitySignalAt + 7200000);
      assert.equal(missing?.outcome_status, "missing_entry");
      const versionTwo = await getPool().query(
        "SELECT signal_version, outcome_status FROM signal_quality_outcomes WHERE source='entity' AND mint=$1 AND signal_at=$2 AND horizon_hours=1 AND signal_version=2",
        [qualityMints[0], qualitySignalAt],
      );
      assert.equal(versionTwo.rows.length, 1);
      assert.equal(Number(versionTwo.rows[0].signal_version), 2);
      assert.equal(versionTwo.rows[0].outcome_status, "ready");

      await getPool().query(
        "INSERT INTO twitter_tweets(tweet_id,handle,text,posted_at,first_seen_at,updated_at) VALUES($1,$2,'mint mention',$3,$4,$4)",
        [qualityAuthorTweetId, qualityAuthorHandle, qualitySignalAt - 10 * 60000, Date.now()],
      );
      await getPool().query(
        "INSERT INTO tweet_token_links(tweet_id,mint,handle,linked_at,match_method,match_level,confidence,evidence,linker_version) " +
        "VALUES($1,$2,$3,$4,'mint_literal','exact',1,$5::jsonb,'v1')",
        [qualityAuthorTweetId, qualityMints[0], qualityAuthorHandle, Date.now(), JSON.stringify({ kind: "mint_literal", address: qualityMints[0], position: 0 })],
      );
      const authorMart = await getPool().query(
        "SELECT attributed_signals::text,ready_outcomes::text,avg_attention_change_pct::text " +
        "FROM v_signal_quality_by_author WHERE source='entity' AND signal_version=1 AND handle=$1 AND horizon_hours=1",
        [qualityAuthorHandle],
      );
      assert.equal(authorMart.rows.length, 1);
      assert.equal(Number(authorMart.rows[0].attributed_signals), 1);
      assert.equal(Number(authorMart.rows[0].ready_outcomes), 1);
      assert.equal(Number(authorMart.rows[0].avg_attention_change_pct), 50);
      const dayBucket = Math.floor(qualitySignalAt / 86400000) * 86400000;
      const mart = await getPool().query("SELECT candidate_signals::text,ready_outcomes::text,coverage_pct::text,avg_attention_change_pct::text FROM v_signal_quality_mart WHERE source='entity' AND signal_version=1 AND horizon_hours=1 AND day_start_ms=$1 AND score_band='70-84'", [dayBucket]);
      assert.equal(mart.rows.length, 1);
      assert.equal(Number(mart.rows[0].candidate_signals), 2);
      assert.equal(Number(mart.rows[0].ready_outcomes), 1);
      assert.equal(Number(mart.rows[0].coverage_pct), 50);
      assert.equal(Number(mart.rows[0].avg_attention_change_pct), 50);
      const mintMart = await getPool().query("SELECT candidate_signals::text,ready_outcomes::text,coverage_pct::text,avg_attention_change_pct::text FROM v_signal_quality_by_mint WHERE source='entity' AND signal_version=1 AND mint=$1 AND horizon_hours=1", [qualityMints[0]]);
      assert.equal(mintMart.rows.length, 1);
      assert.equal(Number(mintMart.rows[0].candidate_signals), 1);
      assert.equal(Number(mintMart.rows[0].ready_outcomes), 1);
      assert.equal(Number(mintMart.rows[0].coverage_pct), 100);
      assert.equal(Number(mintMart.rows[0].avg_attention_change_pct), 50);
    } finally {
      await getPool().query("DELETE FROM tweet_token_links WHERE tweet_id = $1", [qualityAuthorTweetId]);
      await getPool().query("DELETE FROM twitter_tweets WHERE tweet_id = $1", [qualityAuthorTweetId]);
      await getPool().query("DELETE FROM signal_quality_outcomes WHERE mint = ANY($1::text[])", [qualityMints]);
      await getPool().query("DELETE FROM signal_history WHERE mint = ANY($1::text[])", [qualityMints]);
      await getPool().query("DELETE FROM mint_attention_snapshots WHERE mint = ANY($1::text[])", [qualityMints]);
    }
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

    const tweet={id:"1234567890123456789",text:"$SOL @alice",authorHandle:"alice",authorId:"9007199254740993",authorDisplayName:null,
      url:"https://x.com/alice/status/1234567890123456789",views:null,likes:1,retweets:null,replies:0,
      isVerified:false,postedAt:Date.parse("2025-01-01"),observedAt:Date.parse("2025-01-02")};
    // Entity FK must see the outer uncommitted tweet; no nested connection allowed.
    const rawEnvelope = { endpoint: "SearchTimeline", queryId: "fixture-query",
      variables: { rawQuery: "$SOL", cursor: "fixture-cursor" },
      response: { data: { search_by_raw_query: { meta: { next_cursor: "fixture-cursor" } } }, errors: [] } };
    await persistTweets(null,[tweet],null,undefined,undefined,undefined,{rawResponse:rawEnvelope});
    const archivedRaw = (await q<{path:string;response_hash:string;parser_version:string;parse_status:string;response_status:string;expires_at:Date}>("SELECT path,response_hash,parser_version,parse_status,response_status,expires_at FROM archive_raw_pages ORDER BY received_at DESC LIMIT 1"))[0];
    assert(archivedRaw, "raw archive metadata should be committed with the tweet page");
    assert(archivedRaw.parser_version.length > 0);
    assert.equal(archivedRaw.response_hash,createHash("sha256").update(JSON.stringify(rawEnvelope)).digest("hex"));
    assert.equal(archivedRaw.parse_status, "parsed");
    assert.equal(archivedRaw.response_status, "nonempty");
    assert(new Date(archivedRaw.expires_at).getTime() > Date.now(), "raw response must have a future retention expiry");
    const archivedPayload = JSON.parse(gunzipSync(await fs.readFile(archivedRaw.path)).toString("utf8")) as {capture_format_version:number;source_response?:unknown};
    assert.equal(archivedPayload.capture_format_version,1);
    assert.deepEqual(archivedPayload.source_response,rawEnvelope);
    await persistTweets(null,[tweet]);
    assert.equal((await q("SELECT 1 FROM twitter_tweets")).length,1);
    assert.equal((await q<{author_id:string}>("SELECT author_id FROM twitter_tweets WHERE tweet_id=$1",[tweet.id]))[0].author_id,"9007199254740993");
    const metricHistory = await q<{views:number|null;likes:number|null;captured_at:Date}>(
      "SELECT views,likes,captured_at FROM v_twitter_tweet_metrics_history WHERE tweet_id=$1 ORDER BY captured_at DESC LIMIT 1",[tweet.id]);
    assert.equal(metricHistory.length,1);
    assert.equal(metricHistory[0].views,null,"unknown views must remain NULL in metric history");
    assert.equal(Number(metricHistory[0].likes),1);
    assert.equal((await q("SELECT 1 FROM tweet_entities WHERE tweet_id=$1",[tweet.id])).length,2);
    assert.equal((await q("SELECT 1 FROM twitter_tweet_observations")).length,1);
    const rawHashesBeforeInvalid = new Set((await q<{hash:string}>("SELECT hash FROM archive_raw_pages")).map(row=>row.hash));
    const invalidEnvelope = { ...rawEnvelope, variables: { rawQuery: "malformed" } };
    await assert.rejects(persistTweets(null,[{...tweet,id:"123"}],null,undefined,undefined,undefined,{rawResponse:invalidEnvelope}),/collector rejected 1 malformed tweets/);
    const capturedInvalid = (await q<{hash:string;path:string;parse_status:string;response_status:string}>("SELECT hash,path,parse_status,response_status FROM archive_raw_pages")).find(row=>!rawHashesBeforeInvalid.has(row.hash));
    assert(capturedInvalid, "raw response should survive a schema rejection");
    assert.equal(capturedInvalid.parse_status,"failed");
    assert.equal(capturedInvalid.response_status,"error");
    const capturedInvalidPayload = JSON.parse(gunzipSync(await fs.readFile(capturedInvalid.path)).toString("utf8")) as {source_response?:unknown};
    assert.deepEqual(capturedInvalidPayload.source_response,invalidEnvelope);
    await persistTweets(null,[],null,undefined,undefined,undefined,{rawResponse:{...rawEnvelope,variables:{rawQuery:"empty"}}});
    const emptyRaw=(await q<{parse_status:string;response_status:string}>("SELECT parse_status,response_status FROM archive_raw_pages WHERE response_status='empty' ORDER BY received_at DESC LIMIT 1"))[0];
    assert.equal(emptyRaw.parse_status,"parsed");
    assert.equal(emptyRaw.response_status,"empty");
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
