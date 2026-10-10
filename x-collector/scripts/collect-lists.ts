import { q, tx, closePool, getPool } from '../lib/trade/pg';
import { ensureWorker, stopManagedWorker } from '../lib/collector/runtime';
import { closeLogger } from '../lib/trade/logger';

let stopping = false;
let lock:import('pg').PoolClient|undefined;
process.on('message',(message:unknown)=>{if(typeof message==='object'&&message!==null&&'stop' in message&&message.stop)stopping=true;});
process.on('disconnect',()=>{stopping=true;});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
async function tick() {
  await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(742098532)');
    const now = Date.now();
    const sources = (await c.query<{list_id:string;interval_minutes:number}>(
      'SELECT list_id,interval_minutes FROM xc_auto_sources WHERE enabled AND next_run<=$1 ORDER BY list_id', [now])).rows;
    for (const source of sources) {
      const query = `list:${source.list_id}`;
      const active = (await c.query("SELECT id FROM x_tasks WHERE kind='search' AND payload_json->>'query'=$1 AND status IN ('pending','claimed') LIMIT 1", [query])).rows[0];
      let id = active?.id;
      if (!id) id = (await c.query("INSERT INTO x_tasks(kind,payload_json,priority,available_at,created_at,updated_at,max_attempts) VALUES('search',$1::jsonb,2,$2,$2,$2,3) RETURNING id", [JSON.stringify({query,limit:100,sort:'latest'}),now])).rows[0].id;
      await c.query('UPDATE xc_auto_sources SET next_run=$2,last_task_id=$3 WHERE list_id=$1', [source.list_id,now+source.interval_minutes*60000,id]);
    }
  });
  if ((await q("SELECT id FROM x_tasks WHERE kind='search' AND payload_json->>'query' LIKE 'list:%' AND status IN ('pending','claimed') LIMIT 1")).length) await ensureWorker();
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
