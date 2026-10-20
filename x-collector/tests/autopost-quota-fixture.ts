import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const load=createRequire(__filename);
const {dueJobs}=load('../scripts/autopost/queue.cjs');
type Database={query:(sql:string,params?:unknown[])=>Promise<unknown>;exec?:(sql:string)=>Promise<unknown>};
export async function checkAccountQuotas(db:Database){
 const execute=db.exec?db.exec.bind(db):db.query.bind(db);
 await execute('CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint); CREATE TABLE x_tasks(id bigint PRIMARY KEY)');
 const schema=readFileSync('scripts/autopost/schema.sql','utf8');
 await execute(schema);await execute(schema);
 const now=1_800_000_000_000,day=now-12*3600000;
 const names=['quota','ready','night','daytime','disabled','missing','busy','inactive','collector','open','half','expired'];
 for(const name of names){
  await db.query("INSERT INTO x_accounts VALUES($1,$2,$3,$4)",[name,name==='collector'?'collector':'publisher',name==='inactive'?'disabled':'active',name==='busy'?now+1:0]);
  if(name!=='missing')await db.query("INSERT INTO xc_auto_config(account_name,enabled,expected_handle,start_hour,end_hour,daily_limit,updated_at) VALUES($1,$2,$1,$3,$4,2,$5)",[name,name!=='disabled',name==='night'?22:name==='daytime'?9:0,name==='night'?6:name==='daytime'?17:0,now]);
  for(const origin of ['manual','agent'])await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) VALUES($1,$2,$2,'post','fixture',$1,$3,$3,$4)",[name+'-'+origin,name,now-1000,origin]);
 }
 for(const [name,state,resume] of [['open','open',now+1],['half','half_open',now-1],['expired','open',now]] as const)await db.query("INSERT INTO xc_auto_breakers(kind,subject,state,resume_at,updated_at) VALUES('account',$1,$2,$3,$4)",[name,state,resume,now]);
 const history="INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,dedup,status,attempted,attempted_at,started_at,scheduled_at,created_at) VALUES($1,$2,$2,'post',$1,$3,$4,$5,$6,$7,$7)";
 await db.query(history,['quota-cutoff','quota','failed',true,day,null,now]);
 await db.query(history,['quota-uncertain','quota','uncertain',true,day+1,null,now]);
 await db.query(history,['ready-fallback','ready','published',true,null,day,now]);
 await db.query(history,['ready-old','ready','published',true,day-1,now,now]);
 await db.query(history,['ready-unattempted','ready','failed',false,now,now,now]);
 await db.query(history,['ready-not-queued','ready','running',false,null,null,now]);
 await db.query("UPDATE xc_auto_jobs SET scheduled_at=$1 WHERE id='ready-manual'",[now+1]);
 const ids=async(paused=false,hour=12)=>((await dueJobs(db,now,paused,hour,day)) as {id:string}[]).map(j=>j.id);
 const allowedManual=['quota','night','ready','daytime','disabled','missing','expired'].filter(n=>n!=='ready').map(n=>n+'-manual');
 const daytime=await ids();
 assert.deepEqual([...daytime].sort(),[...allowedManual,'ready-agent','daytime-agent','expired-agent'].sort());
 assert(daytime.slice(0,allowedManual.length).every(id=>id.endsWith('-manual')));
 assert.deepEqual((await ids(true)).sort(),allowedManual.sort());
 for(const hour of [22,23,0,5])assert((await ids(false,hour)).includes('night-agent'));
 for(const hour of [6,12,21])assert(!(await ids(false,hour)).includes('night-agent'));
 assert((await ids(false,9)).includes('daytime-agent'));assert(!(await ids(false,17)).includes('daytime-agent'));
 // No upper time bound is introduced: a future attempted record still consumes quota.
 await db.query(history,['ready-future-attempt','ready','failed',true,now+3600000,null,now]);
 assert(!(await ids()).includes('ready-agent'));
 await db.query("UPDATE x_accounts SET account_busy_until=$1 WHERE name='busy'",[now]);
 assert((await ids()).includes('busy-manual'));
 // Many jobs sharing one exhausted account must not recount its history per job.
 await db.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,dedup,scheduled_at,created_at,origin) SELECT 'quota-extra-'||i,'quota','quota','post','quota-extra-'||i,$1::bigint-2000,$1,'agent' FROM generate_series(1,240) i",[now]);
 let captured:{sql:string;args:unknown[]}|undefined;
 await dueJobs({query:async(sql:string,args:unknown[])=>{captured={sql,args};return {rows:[]};}},now,false,12,day);
 assert(captured);
 const result=await db.query('EXPLAIN (ANALYZE, FORMAT JSON) '+captured.sql,captured.args) as {rows:{'QUERY PLAN':{Plan:Plan}[]}[]};
 type Plan={'Node Type':string;'Actual Loops':number;Plans?:Plan[]};
 const walk=(p:Plan):Plan[]=>[p,...(p.Plans||[]).flatMap(walk)];
 const loops=walk(result.rows[0]['QUERY PLAN'][0].Plan).filter(p=>p['Node Type']==='Aggregate').reduce((n,p)=>n+p['Actual Loops'],0);
 assert(loops<=names.length,`Quota aggregates must be bounded by accounts, got ${loops}`);
 assert.deepEqual((await ids()).filter(id=>id.startsWith('quota-')),['quota-manual']);
}
