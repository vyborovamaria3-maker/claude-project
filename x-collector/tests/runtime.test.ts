import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { enqueueTask, claimTasks, finishTask, deferTask, failTask } from '../lib/trade/tasks';
import { pickAccount, releaseAccount, recordError } from '../lib/trade/account-manager';
import { getDailyDigest, getMintFullReport, getTopShillers, getTrendingWords, getCashtagTrends, getWorkerEfficiency, getAccountHealth } from '../lib/trade/analytics';
import { getTopHype, getEarlySignals, getLeadAuthors, getTopPageRank } from '../lib/trade/analytics-advanced';
import { getTopUltra, listModels } from '../lib/trade/analytics-predictive';
import { closePool } from '../lib/trade/pg';
import { clearKeyCache, encryptBuffer, decryptBuffer } from '../lib/trade/crypto';

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
    for (const file of (await fs.readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec(await fs.readFile('migrations/' + file, 'utf8'));
    }
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
    await enqueueTask({ ...input, payload: { query: 'retry' }, maxAttempts: 2 });
    const [retry] = await claimTasks('worker-c', 1, 60000);
    assert.equal(await failTask(retry.id, 'worker-c', 'transient'), 'requeued');
  } finally {
    queryMock.mock.restore(); connectMock.mock.restore();
    await closePool(); await db.close();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
