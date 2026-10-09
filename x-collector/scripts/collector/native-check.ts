import { recordProgress,liveSnapshot } from "../../lib/collector/live";
import { enqueueTask,claimTasks,finishTask } from "../../lib/trade/tasks";
import { persistProfile } from "../../lib/trade/collector-store";
import assert from 'node:assert/strict';
import { q } from '../../lib/trade/pg';
import { ensureWorker,runtimeStatus,stopManagedWorker } from '../../lib/collector/runtime';
export async function checkCollectorNative() {
 const [schema]=await q<{name:string}>('SELECT current_schema() name');
 if(!schema.name.startsWith('reply_test_'))throw new Error('Worker integration requires owned disposable schema');
 assert.equal((await q("SELECT id FROM x_tasks WHERE status IN ('pending','claimed')")).length,0,'no external tasks may run in worker startup fixture');
 const id=await enqueueTask({kind:"profile",payload:{handle:"native"},dedup:false});assert(id);
 const [task]=await claimTasks("native-progress",1,60000);assert.equal(Number(task.id),Number(id));
 assert(await recordProgress(Number(id),"native-progress",task.attempts,{phase:"profile",account:"fixture",currentAuthor:"native"}));
 assert.equal(await recordProgress(Number(id),"old-owner",task.attempts,{phase:"collecting",found:99}),false);
 await persistProfile({handle:"native",displayName:null,bio:null,followers:3,following:null,postsCount:null,isVerified:false,joinedAt:null,avatarUrl:null},Number(id));
 const snapshot=await liveSnapshot();assert.equal(Number(snapshot.jobs.find(j=>String(j.id)===String(id))?.saved_profiles),1);
 assert(!("session_encrypted" in snapshot.accounts[0]));assert(await finishTask(task.id,"native-progress"));
 assert.equal(await recordProgress(Number(id),"native-progress",task.attempts,{phase:"profile"}),false);
 try {
 await Promise.all([ensureWorker(),ensureWorker()]);
 assert.equal(runtimeStatus().managed,true);
 assert.equal((await q("SELECT id FROM x_workers WHERE status='active'")).length,1);
 }finally{await stopManagedWorker();}
 assert.equal(runtimeStatus().managed,false);
 assert.equal((await q("SELECT id FROM x_workers WHERE status='active'")).length,0);
 console.log('Collector worker integration passed: concurrent start, IPC readiness, registry heartbeat and graceful stop; no X requests');
}
