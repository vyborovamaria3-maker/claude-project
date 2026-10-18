import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {isRetryablePgError} from '../lib/trade/retry';
const {runHistoryProducer}=createRequire(__filename)('../scripts/history-runner.cjs');

test('history recovers idle disconnect and reacquires exclusive lock before its next cycle',async()=>{
 const stop=new AbortController();const events:string[]=[];let opens=0,cycles=0;let client:EventEmitter;
 await runHistoryProducer({signal:stop.signal,isTransient:isRetryablePgError,
  open:async(onError:()=>void)=>{opens++;client=new EventEmitter();client.on('error',onError);return Object.assign(client,{query:async()=>{events.push('lock'+opens);return {rows:[{locked:true}]};},end:async()=>{events.push('close'+opens);}});},
  cycle:async()=>{events.push('cycle'+(++cycles));if(cycles===2)stop.abort();},
  sleep:async()=>{if(cycles===1)client.emit('error',new Error('Connection terminated unexpectedly'));},
 });
 assert.equal(opens,2);assert.deepEqual(events,['lock1','cycle1','close1','lock2','cycle2','close2']);
});

test('history retries startup refusal, exits if another producer owns lock and closes session',async()=>{
 let opens=0,closed=0;const waits:number[]=[];
 await runHistoryProducer({signal:new AbortController().signal,isTransient:isRetryablePgError,
  open:async()=>{if(++opens===1)throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});return {query:async()=>({rows:[{locked:false}]}),end:async()=>{closed++;}};},
  cycle:async()=>assert.fail('must not produce without lock'),sleep:async(ms:number)=>{waits.push(ms);},
 });
 assert.equal(opens,2);assert.equal(closed,1);assert.deepEqual(waits,[1000]);
});

test('history closes broken session without replaying an uncertain transaction',async()=>{
 const stop=new AbortController();let cycles=0,opens=0;
 await runHistoryProducer({signal:stop.signal,isTransient:isRetryablePgError,
  open:async()=>{opens++;return {query:async()=>({rows:[{locked:true}]}),end:async()=>{}};},
  cycle:async()=>{cycles++;throw Object.assign(new Error('connection lost at COMMIT'),{code:'ECONNRESET'});},
  sleep:async()=>{stop.abort();},
 });
 assert.equal(cycles,1);assert.equal(opens,1);
});

test('history rejects schema errors instead of reconnecting indefinitely',async()=>{
 await assert.rejects(runHistoryProducer({signal:new AbortController().signal,isTransient:isRetryablePgError,
  open:async()=>({query:async()=>({rows:[{locked:true}]}),end:async()=>{}}),
  cycle:async()=>{throw Object.assign(new Error('missing table'),{code:'42P01'});},
 }),/missing table/);
});

test('history shutdown cancels reconnect backoff promptly',async()=>{
 const stop=new AbortController();let opens=0;
 const result=runHistoryProducer({signal:stop.signal,isTransient:isRetryablePgError,
  open:async()=>{opens++;throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});},
  cycle:async()=>assert.fail('offline'),report:()=>{setImmediate(()=>stop.abort());},
 });
 await result;assert.equal(opens,1);
});
