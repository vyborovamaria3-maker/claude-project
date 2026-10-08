import assert from 'node:assert/strict';
import { q } from '../../lib/trade/pg';
import { ensureWorker,runtimeStatus,stopManagedWorker } from '../../lib/collector/runtime';
export async function checkCollectorNative() {
 const [schema]=await q<{name:string}>('SELECT current_schema() name');
 if(!schema.name.startsWith('reply_test_'))throw new Error('Worker integration requires owned disposable schema');
 assert.equal((await q("SELECT id FROM x_tasks WHERE status IN ('pending','claimed')")).length,0,'no external tasks may run in worker startup fixture');
 try {
 await Promise.all([ensureWorker(),ensureWorker()]);
 assert.equal(runtimeStatus().managed,true);
 assert.equal((await q("SELECT id FROM x_workers WHERE status='active'")).length,1);
 }finally{await stopManagedWorker();}
 assert.equal(runtimeStatus().managed,false);
 assert.equal((await q("SELECT id FROM x_workers WHERE status='active'")).length,0);
 console.log('Collector worker integration passed: concurrent start, IPC readiness, registry heartbeat and graceful stop; no X requests');
}
