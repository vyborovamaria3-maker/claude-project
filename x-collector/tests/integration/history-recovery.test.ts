import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from 'pg';
import {createRequire} from 'node:module';
import {isRetryablePgError} from '../../lib/trade/retry';
const {runHistoryProducer}=createRequire(__filename)('../../scripts/history-runner.cjs');

test('real PostgreSQL: history reconnects after its own backend is terminated and reacquires lock',{
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:15000,
},async()=>{
 const connectionString=process.env.RUNTIME_TEST_DATABASE_URL!;
 assert(new URL(connectionString).pathname.endsWith('_test'));
 const admin=new Client({connectionString});await admin.connect();
 const stop=new AbortController();let opens=0,cycles=0;const pids:number[]=[];
 try{
  await runHistoryProducer({signal:stop.signal,isTransient:isRetryablePgError,
   open:async(onError:(error:Error)=>void)=>{const c=new Client({connectionString});c.on('error',onError);await c.connect();opens++;return c;},
   cycle:async(c:Client)=>{
    const pid=Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);pids.push(pid);cycles++;
    // A competitor must not obtain the producer lock on either session.
    assert.equal((await admin.query('SELECT pg_try_advisory_lock(742098534) locked')).rows[0].locked,false);
    if(cycles===1){await admin.query('SELECT pg_terminate_backend($1)',[pid]);await c.query('SELECT 1');}
    else stop.abort();
   },sleep:async()=>{},
  });
  assert.equal(opens,2);assert.equal(cycles,2);assert.notEqual(pids[0],pids[1]);
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(742098534) locked')).rows[0].locked,true);
 }finally{stop.abort();await admin.end();}
});
