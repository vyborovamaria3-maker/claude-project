import { q, tx, closePool, getPool } from '../lib/trade/pg';
import { ensureWorker, stopManagedWorker } from '../lib/collector/runtime';
import { closeLogger } from '../lib/trade/logger';
import { createRequire } from 'node:module';
const {tickDiscovery}=createRequire(__filename)('./discovery-core.cjs');
const {tickSources}=createRequire(__filename)('./list-core.cjs');

let stopping = false;
let lock:import('pg').PoolClient|undefined;
process.on('message',(message:unknown)=>{if(typeof message==='object'&&message!==null&&'stop' in message&&message.stop)stopping=true;});
process.on('disconnect',()=>{stopping=true;});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
async function tick() {
  await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(742098532)');
    await tickSources(c);
    await tickDiscovery(c);
  });
  if ((await q("SELECT id FROM x_tasks WHERE kind='search' AND (payload_json->>'query' LIKE 'list:%' OR payload_json ? 'discovery_source') AND status IN ('pending','claimed') LIMIT 1")).length) await ensureWorker();
}
async function main() {
  lock=await getPool().connect();
  if(!(await lock.query('SELECT pg_try_advisory_lock(742098533) AS locked')).rows[0].locked)return;
  const ids = process.argv.slice(2).map(raw => /^https:\/\/x\.com\/i\/lists\/(\d{1,25})\/?$/.exec(raw)?.[1] ?? raw);
  if (ids.some(id => !/^\d{1,25}$/.test(id))) throw new Error('Expected X list IDs or https://x.com/i/lists/ID');
  for (const id of ids) await q('INSERT INTO xc_auto_sources(list_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
  console.log('List source collector started; sources are stored in PostgreSQL.');
  while (!stopping) {
    try { await tick(); } catch { console.error('List collection failed. Check schema, collector logs and X session.'); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 15000));
  }
}
main().catch(() => { console.error('Cannot start list collector; run setup-autopost.cjs and check database.'); process.exitCode=1; })
  .finally(async () => { await stopManagedWorker(); if(lock){await lock.query('SELECT pg_advisory_unlock(742098533)').catch(()=>{});lock.release();} await closePool(); await closeLogger(); });
