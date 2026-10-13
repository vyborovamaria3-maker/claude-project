import { REQUIRED } from "../lib/trade/migrations";
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { enqueueTask, claimTasks, finishTask, deferTask, failTask, extendLease, replayDeadLetter, QueueBackpressureError } from '../lib/trade/tasks';
import { pickAccount, accountWaitMs, releaseAccount, recordError, extendAccountLease } from '../lib/trade/account-manager';
import { CollectorHttpError, taskFailure, retryAfterMs } from '../lib/trade/task-errors';
import { WorkerRuntime } from '../src/runtime/worker-runtime';
import { executeTask } from '../src/runtime/collector-task';
import { WorkerRegistry, reapDeadWorkers } from '../lib/trade/worker-registry';
import { getDailyDigest, getMintFullReport, getTopShillers, getTrendingWords, getCashtagTrends, getWorkerEfficiency, getAccountHealth } from '../lib/trade/analytics';
import { getTopHype, getEarlySignals, getLeadAuthors, getTopPageRank } from '../lib/trade/analytics-advanced';
import { getTopUltra, listModels } from '../lib/trade/analytics-predictive';
import { closePool } from '../lib/trade/pg';
import { clearKeyCache, encryptBuffer, decryptBuffer } from '../lib/trade/crypto';
import { handleSearchTask } from '../src/x/task-handler';

test('encrypted sessions reject tampering and wrong keys', () => {
  const previous = process.env.MASTER_KEY;
  try {
    process.env.MASTER_KEY = 'ab'.repeat(32); clearKeyCache();
    const plain = Buffer.from('{"cookies":[]}');
    const first = encryptBuffer(plain), second = encryptBuffer(plain);
    assert.notDeepEqual(first, second);
    assert.deepEqual(decryptBuffer(first), plain);
    const tampered = Buffer.from(first); tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptBuffer(tampered));
    process.env.MASTER_KEY = 'cd'.repeat(32); clearKeyCache();
    assert.throws(() => decryptBuffer(first));
  } finally {
    clearKeyCache();
    if (previous === undefined) delete process.env.MASTER_KEY; else process.env.MASTER_KEY = previous;
  }
});

test('queue lease ownership, retries, DLQ and account ownership against SQL engine', async () => {
  const db = new PGlite();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://unused/isolated_test';
  // Only transport is adapted: production functions execute their actual SQL.
  const query = async (sql: string, params: unknown[] = []) => {
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const queryMock = mock.method(Pool.prototype, 'query', query);
  const connectMock = mock.method(Pool.prototype, 'connect', async () => ({ query, release() {} }));
  try {
    for (const file of REQUIRED) {
      await db.exec(await fs.readFile('migrations/' + file, 'utf8'));
    }
    // A populated/previously migrated database must receive the same idempotent repair.
    const definitions = await db.query('SELECT oid,prosrc FROM pg_proc WHERE pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema()) ORDER BY oid');
    await db.exec(await fs.readFile('migrations/038_analytics_bigint_durations.sql','utf8'));
    assert.deepEqual((await db.query('SELECT oid,prosrc FROM pg_proc WHERE pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema()) ORDER BY oid')).rows,definitions.rows);
    assert.equal((await db.query<{n:number}>('SELECT rollup_mint_1w($1,$2) AS n',[1791000000000,1791767667000])).rows[0].n,0);
    assert.equal((await db.query<{n:number}>('SELECT rebuild_author_metrics_1d($1,$2) AS n',[1791000000000,1791767667000])).rows[0].n,0);
    assert.equal((await db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.prokind='f' AND p.prosrc ~ '\\m(30|90)[[:space:]]*\\*[[:space:]]*86400000\\M' AND p.prosrc !~ '86400000::BIGINT'")).rows.length,0);
    for (const read of [getDailyDigest, getTopShillers, getTrendingWords, getCashtagTrends, getWorkerEfficiency, getAccountHealth, getTopHype, getEarlySignals, getLeadAuthors, getTopPageRank, getTopUltra, listModels]) await read();
    const report = await getMintFullReport('11111111111111111111111111111111');
    assert.equal(report.summary, null);
    assert.deepEqual(report.dailyFunnel, []);
    const input = { kind: 'search' as const, payload: { query: 'mint', limit: 10 }, maxAttempts: 1 };
    const id = await enqueueTask(input); assert(id);
    assert.equal(await enqueueTask(input), null);
    const [claimed] = await claimTasks('worker-a', 1, 60000);
    assert.equal(Number(claimed.id), Number(id));
    assert.equal(await finishTask(claimed.id, 'worker-b'), false);
    assert.equal(await deferTask(claimed.id, 'worker-a', 0), true);
    const [again] = await claimTasks('worker-b', 1, 60000);
    assert.equal(again.attempts, 1);
    assert.equal(await failTask(again.id, 'worker-a', 'stale worker'), 'lost');
    assert.equal(await failTask(again.id, 'worker-b', 'test failure'), 'dlq');
    assert.equal((await db.query('SELECT * FROM x_tasks_dlq')).rows.length, 1);
    const expiredId = await enqueueTask({ ...input, payload: { query: 'expired' }, maxAttempts: 2 });
    await claimTasks('worker-a', 1, 60000);
    await db.query('UPDATE x_tasks SET lease_expires_at=0 WHERE id=$1', [expiredId]);
    const [reclaimed] = await claimTasks('worker-b', 1, 60000);
    assert.equal(Number(reclaimed.id), Number(expiredId));
    assert.equal(await finishTask(reclaimed.id, 'worker-a'), false);
    assert.equal(await finishTask(reclaimed.id, 'worker-b'), true);
    await db.query("INSERT INTO x_accounts(name, session_encrypted, hour_window_start, created_at, updated_at) VALUES ('test', $1, 0, 0, 0)", [Buffer.from('encrypted-test-fixture')]);
    const account = await pickAccount('search', 'owner-a'); assert(account);
    assert.equal(await pickAccount('search', 'owner-b'), null);
    assert.equal(await releaseAccount('test', 'owner-b'), false);
    assert.equal(await releaseAccount('test', 'owner-a'), true);
    await recordError('test', 'rate_limit');
    const state = await db.query<{ status: string; cooldown_until: number }>("SELECT status, cooldown_until FROM x_accounts WHERE name='test'");
    assert.equal(state.rows[0].status, 'cooldown');
    assert(Number(state.rows[0].cooldown_until) > Date.now());
    await db.query("INSERT INTO x_accounts(name,session_encrypted,hour_window_start,created_at,updated_at,role) VALUES('fallback',$1,0,0,0,'collector'),('publisher-only',$1,0,0,0,'publisher')",[Buffer.from('fixture')]);
    assert.equal(await pickAccount('search','strict','test'),null);
    assert(await accountWaitMs('search','test')>5000);
    const fallback=await pickAccount('search','fallback-owner','test',true);
    assert.equal(fallback?.name,'fallback');
    assert.equal(await releaseAccount('fallback','fallback-owner'),true);
    await db.query("INSERT INTO x_accounts(name,session_encrypted,hour_window_start,created_at,updated_at,role) VALUES('second',$1,0,0,0,'collector')",[Buffer.from('fixture')]);
    await db.query('UPDATE xc_discovery_plan SET enabled=true,max_browser_accounts=1');
    const capped=await pickAccount('search','capped-a');assert(capped);
    assert.equal(await pickAccount('search','capped-b'),null);
    assert.equal(await releaseAccount(capped.name,'capped-a'),true);
    assert(await pickAccount('search','capped-b'));
    await db.query('UPDATE xc_discovery_plan SET enabled=false');
    await db.query("DELETE FROM x_accounts WHERE name='second'");
    await db.query("UPDATE x_accounts SET account_busy_until=0,account_claimed_by=NULL WHERE name='fallback'");
    await db.query("DELETE FROM x_accounts WHERE name IN ('fallback','publisher-only')");
    await enqueueTask({ ...input, payload: { query: 'retry' }, maxAttempts: 2 });
    const [retry] = await claimTasks('worker-c', 1, 60000);
    assert.equal(await failTask(retry.id, 'worker-c', 'transient'), 'requeued');
    await db.query("UPDATE x_tasks SET status='done' WHERE status='pending'");
    await enqueueTask({ ...input, payload: { query: 'fenced' }, maxAttempts: 3 });
    const [fenced] = await claimTasks('same-worker', 1, 60000);
    assert.equal(await extendLease(fenced.id, 'same-worker', 60000, fenced.attempts + 1), false);
    assert.equal(await finishTask(fenced.id, 'same-worker', fenced.attempts + 1), false);
    await db.query('UPDATE x_tasks SET lease_expires_at=0 WHERE id=$1', [fenced.id]);
    assert.equal(await extendLease(fenced.id, 'same-worker', 60000), false);
    assert.equal(await finishTask(fenced.id, 'same-worker'), false);
    assert.equal(await deferTask(fenced.id, 'same-worker'), false);
    assert.equal(await failTask(fenced.id, 'same-worker', 'failure'), 'lost');
    const [newAttempt] = await claimTasks('same-worker', 1, 60000);
    assert.equal(await finishTask(fenced.id, 'same-worker', fenced.attempts), false);
    assert.equal(await failTask(newAttempt.id, 'same-worker', new CollectorHttpError(401), newAttempt.attempts), 'requeued');
    await enqueueTask({ ...input, payload: { query: 'rate-delay' }, maxAttempts: 3 });
    const [limited] = await claimTasks('worker-limit', 1, 60000);
    const before = Date.now();
    assert.equal(await failTask(limited.id, 'worker-limit', new CollectorHttpError(429, 120000)), 'requeued');
    const delayed = (await db.query<{available_at:string}>('SELECT available_at FROM x_tasks WHERE id=$1', [limited.id])).rows[0];
    assert(Number(delayed.available_at) >= before + 120000);
    await db.query("UPDATE x_accounts SET status='active',cooldown_until=0 WHERE name='test'");
    await pickAccount('search', 'expired-owner');
    await db.query("UPDATE x_accounts SET account_busy_until=0 WHERE name='test'");
    assert.equal(await extendAccountLease('test', 'expired-owner', 60000), false);
    for (let i=0;i<4;i++) await recordError('test', 'rate_limit');
    assert.equal((await db.query<{status:string}>("SELECT status FROM x_accounts WHERE name='test'")).rows[0].status, 'cooldown');
    await recordError('test', 'auth_expired');
    assert.equal((await db.query<{status:string}>("SELECT status FROM x_accounts WHERE name='test'")).rows[0].status, 'captcha');
    // A missing heartbeat must not revoke a valid task lease.
    await db.query("UPDATE x_tasks SET status='done' WHERE status='pending'");
    await enqueueTask({ ...input, payload: { query: 'heartbeat' }, maxAttempts: 3 });
    const [alive] = await claimTasks('heartbeat-worker', 1, 60000);
    await db.query("INSERT INTO x_workers(id,started_at,last_heartbeat,status) VALUES('heartbeat-worker',0,0,'active')");
    await reapDeadWorkers();
    assert.equal(await finishTask(alive.id, 'heartbeat-worker'), true);
    // Actual worker handler plus durable queue: invalid input goes directly to DLQ.
    await enqueueTask({ kind:'profile', payload:{handle:'!'}, maxAttempts:3 });
    const [invalid] = await claimTasks('handler-worker', 1, 60000);
    const runtime = new WorkerRuntime('handler-worker'); runtime.ready();
    const context = {workerId:'handler-worker',registry:new WorkerRegistry('handler-worker'),signal:new AbortController().signal,isStopping:()=>false,useSourceCollector:false};
    assert.equal(await runtime.runJob(invalid, job=>executeTask(job,context)), 'invalid-payload');
    assert.equal((await db.query<{status:string}>('SELECT status FROM x_tasks WHERE id=$1',[invalid.id])).rows[0].status,'failed');
    await enqueueTask({ kind:'profile',payload:{handle:'alice'},maxAttempts:3 });
    const [waiting] = await claimTasks('handler-worker', 1, 60000);
    assert.equal(await runtime.runJob(waiting,job=>executeTask(job,context)), 'no-account');
    assert.equal((await db.query<{attempts:number}>('SELECT attempts FROM x_tasks WHERE id=$1',[waiting.id])).rows[0].attempts,0);
    await db.query("UPDATE x_tasks SET status='done' WHERE status='pending'");
    // Account failures quarantine only that account; a second account can finish the job.
    const previousKey = process.env.MASTER_KEY;
    try {
      process.env.MASTER_KEY = 'ab'.repeat(32); clearKeyCache();
      const session = encryptBuffer(Buffer.from(JSON.stringify({cookies:[{name:'auth_token',value:'fixture',domain:'.x.com',path:'/'}]})));
      for (const status of [401,403]) {
        await db.query("UPDATE x_accounts SET status='captcha'");
        for (const [name,tier] of [['broken-'+status,'hot'],['healthy-'+status,'warm']]) {
          await db.query("INSERT INTO x_accounts(name,tier,session_encrypted,hour_window_start,created_at,updated_at) VALUES($1,$2,$3,0,0,0)",[name,tier,session]);
        }
        const id = await enqueueTask({kind:'search',payload:{query:'account-recovery-'+status},maxAttempts:3});
        const [first] = await claimTasks('recovery-worker',1,60000);
        assert.equal(Number(first.id),Number(id));
        await assert.rejects(handleSearchTask(first,{search:async()=>{throw new CollectorHttpError(status);}}),CollectorHttpError);
        const broken = (await db.query<{status:string;account_claimed_by:string|null}>("SELECT status,account_claimed_by FROM x_accounts WHERE name=$1",['broken-'+status])).rows[0];
        assert.equal(broken.status,'captcha');
        assert.equal(broken.account_claimed_by,null);
        assert.equal(await failTask(first.id,'recovery-worker',new CollectorHttpError(status),first.attempts),'requeued');
        assert.equal((await db.query("SELECT 1 FROM x_tasks_dlq WHERE original_id=$1",[id])).rows.length,0);
        await db.query('UPDATE x_tasks SET available_at=0 WHERE id=$1',[id]);
        const [second] = await claimTasks('recovery-worker',1,60000);
        assert.equal(second.attempts,2);
        await handleSearchTask(second,{search:async()=>[]});
        const healthy = (await db.query<{status:string;last_success_at:string}>("SELECT status,last_success_at FROM x_accounts WHERE name=$1",['healthy-'+status])).rows[0];
        assert.equal(healthy.status,'active');
        assert(Number(healthy.last_success_at)>0);
        assert.equal(await finishTask(second.id,'recovery-worker',second.attempts),true);
      }
    } finally {
      clearKeyCache();
      if(previousKey===undefined)delete process.env.MASTER_KEY;else process.env.MASTER_KEY=previousKey;
    }
    assert.equal(await replayDeadLetter(invalid.id),true);
    assert.equal(await replayDeadLetter(invalid.id),false);
    const previousCap = process.env.COLLECTOR_MAX_BACKLOG;
    try {
      process.env.COLLECTOR_MAX_BACKLOG='1';
      await assert.rejects(enqueueTask({kind:'profile',payload:{handle:'extra'}}),QueueBackpressureError);
      assert.equal((await db.query("SELECT 1 FROM x_tasks WHERE status IN ('pending','claimed')")).rows.length,1);
    } finally { if(previousCap===undefined)delete process.env.COLLECTOR_MAX_BACKLOG;else process.env.COLLECTOR_MAX_BACKLOG=previousCap; }
  } finally {
    queryMock.mock.restore(); connectMock.mock.restore();
    await closePool(); await db.close();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});

test('worker lifecycle rejects concurrent claims, drains stopping work and preserves errors', async () => {
  const runtime = new WorkerRuntime('fixture'); runtime.ready();
  const job = {id:1,kind:'profile' as const,payloadJson:'{}',mint:null,handle:null,attempts:1,maxAttempts:3,claimedBy:'fixture'};
  let finish!: (value:string)=>void;
  const active = runtime.runJob(job,()=>new Promise<string>(resolve=>{finish=resolve;}));
  await Promise.resolve();
  assert.equal(runtime.snapshot().status,'RUNNING');
  await assert.rejects(runtime.runJob(job,async()=>"done"),/not accepting/);
  const stop = runtime.stop();
  assert.equal(runtime.snapshot().ready,false);
  finish('done'); await active; await stop;
  assert.equal(runtime.snapshot().completedJobs,1);
  assert.equal(runtime.snapshot().status,'STOPPED');
  await assert.rejects(runtime.runJob(job,async()=>"done"),/not accepting/);
  const failed = new WorkerRuntime('failed'); failed.ready();
  await assert.rejects(failed.runJob(job,async()=>{throw new Error('DB unavailable');}),/DB unavailable/);
  assert.equal(failed.snapshot().failedJobs,1);
});

test('failure classification distinguishes access, rate limits and upstream errors',()=>{
  assert.equal(taskFailure(new CollectorHttpError(503)).permanent,false);
  assert.equal(taskFailure(new CollectorHttpError(401)).permanent,false);
  assert.equal(taskFailure(new CollectorHttpError(403)).permanent,false);
  assert.equal(taskFailure('schema: invalid input').permanent,true);
  assert.equal(retryAfterMs('120'),120000);
  assert.equal(retryAfterMs(new Date(125000).toUTCString(),5000),120000);
  assert.equal(retryAfterMs('bad'),0);
});
