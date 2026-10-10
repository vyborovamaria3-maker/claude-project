import 'dotenv/config';
import {tx,closePool} from '../lib/trade/pg';
import {normalizeRaw} from '../lib/trade/intelligence-store';
import {setTimeout as delay} from 'node:timers/promises';
const stop=new AbortController();
process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());

async function main(){
 let processed=0;
 while(!stop.signal.aborted){
  const count=await tx(async c=>{
   const rows=await c.query<{id:string;event_type:string;payload:unknown;collected_at:Date}>(`SELECT id,event_type,payload,collected_at FROM ip_raw_events WHERE normalized_at IS NULL AND normalization_attempts<3 ORDER BY collected_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`);
   for(const row of rows.rows){
    await c.query('SAVEPOINT normalize_event');
    try{await normalizeRaw(c,row);await c.query('RELEASE SAVEPOINT normalize_event');}
    catch{await c.query('ROLLBACK TO SAVEPOINT normalize_event');await c.query("UPDATE ip_raw_events SET normalization_attempts=normalization_attempts+1,normalization_error='Normalization failed; inspect original payload' WHERE id=$1",[row.id]);await c.query('RELEASE SAVEPOINT normalize_event');}
   }
   return rows.rows.length;
  });
  processed+=count;if(!count){if(!process.argv.includes('--watch'))break;await delay(10000,undefined,{signal:stop.signal}).catch(()=>{});}
 }
 console.log(JSON.stringify({processed}));
}
main().catch(()=>{console.error('Intelligence normalization failed; raw events preserved for retry');process.exitCode=1;}).finally(closePool);
