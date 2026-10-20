// SQL only: no Worker, browser, session, key or X request is loaded.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {dueJobs}=require('./queue.cjs');
async function main(){
 const raw=process.env.RUNTIME_TEST_DATABASE_URL,output=process.env.QUEUE_BENCHMARK_OUTPUT;
 if(!raw||!output)throw Error('RUNTIME_TEST_DATABASE_URL and QUEUE_BENCHMARK_OUTPUT required');
 const url=new URL(raw);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!decodeURIComponent(url.pathname).endsWith('_test'))throw Error('Dedicated loopback *_test database required');
 const count=Number(process.env.QUEUE_BENCHMARK_ROWS||200000);
 if(!Number.isInteger(count)||count<10000||count>1000000||count%100)throw Error('Rows must be a multiple of 100 between 10000 and 1000000');
 const c=new Client({connectionString:raw,application_name:'x-collector-offline-queue-benchmark'});
 const schema='queue_bench_'+randomUUID().replaceAll('-','');
 const report={rows:count+4,accounts:100,manual:4,history:count/2,readyAgent:count*0.4,futureAgent:count*0.1,measurements:[]};
 let created=false;
 await c.connect();
 try{
  report.postgres=(await c.query('SHOW server_version')).rows[0].server_version;
  await c.query('SET statement_timeout=120000');
  await c.query('CREATE SCHEMA "'+schema+'"');created=true;
  await c.query('SET search_path TO "'+schema+'",public');
  await c.query('CREATE TABLE x_accounts(name text PRIMARY KEY,role text,status text,account_busy_until bigint); CREATE TABLE x_tasks(id bigint PRIMARY KEY)');
  await c.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  const now=Date.now(),day=Math.floor((now+10800000)/86400000)*86400000-10800000;
  await c.query("INSERT INTO x_accounts SELECT 'fixture_'||i,'publisher','active',0 FROM generate_series(0,99) i");
  await c.query("INSERT INTO xc_auto_config(account_name,enabled,expected_handle,start_hour,end_hour,daily_limit,updated_at) SELECT name,true,name,0,0,4,$1 FROM x_accounts",[now]);
  await c.query(`INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,status,attempted,attempted_at,scheduled_at,created_at,origin)
   SELECT 'fixture-'||i,'fixture_'||(i%100),'fixture_'||(i%100),'post','artificial queue fixture','fixture-dedup-'||i,
    CASE WHEN i<$2/2 THEN 'published' ELSE 'queued' END,i<$2/2,
    CASE WHEN i<$2/2 THEN $3::bigint-86400000 ELSE NULL END,
    CASE WHEN i>=$2*9/10 THEN $1::bigint+86400000+i ELSE $1::bigint-$2+i END,$1::bigint-$2+i,'agent'
   FROM generate_series(0,$2::int-1) i`,[now,count,day]);
  await c.query("INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,scheduled_at,created_at,origin) SELECT 'manual-'||i,'fixture_'||i,'fixture_'||i,'post','artificial manual fixture','manual-dedup-'||i,$1::bigint-1,$1,'manual' FROM generate_series(0,3) i",[now]);
  await c.query('ANALYZE x_accounts; ANALYZE xc_auto_jobs; ANALYZE xc_auto_config; ANALYZE xc_auto_breakers');
  // Capture the actual runtime query, rather than a separately maintained approximation.
  async function query(paused){let captured;await dueJobs({query:async(sql,args)=>{captured={sql,args};return {rows:[]};}},now,paused,12,day);return captured;}
  function nodes(plan){return [plan,...(plan.Plans||[]).flatMap(nodes)];}
  async function measure(name,paused,repeats=1){
   const {sql,args}=await query(paused),entry={name,paused,runs:[]};report.measurements.push(entry);
   await c.query('SET statement_timeout=15000');
   for(let i=0;i<repeats;i++){
    try{
     const p=(await c.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0];
     const ns=nodes(p.Plan);
     entry.runs.push({executionMs:p['Execution Time'],planningMs:p['Planning Time'],rows:p.Plan['Actual Rows'],sharedHit:p.Plan['Shared Hit Blocks'],sharedRead:p.Plan['Shared Read Blocks'],tempRead:p.Plan['Temp Read Blocks'],tempWritten:p.Plan['Temp Written Blocks'],indexes:[...new Set(ns.map(n=>n['Index Name']).filter(Boolean))],plan:p});
    }catch(e){if(e.code!=='57014')throw e;entry.timeoutMs=15000;entry.estimatedPlan=(await c.query('EXPLAIN (FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0];break;}
   }
   console.log(JSON.stringify({name,timeoutMs:entry.timeoutMs,runs:entry.runs.map(({plan:_plan,...summary})=>summary)}));
   return entry;
  }
  const selected=await dueJobs(c,now,false,12,day);
  assert.equal(selected.length,20);assert.deepEqual(selected.slice(0,4).map(j=>j.id).sort(),['manual-0','manual-1','manual-2','manual-3']);
  assert(selected.slice(4).every(j=>j.origin==='agent'));report.manualFirstVerified=true;
  await measure('mixed_with_priority_index',false,3);
  assert.deepEqual((await dueJobs(c,now,true,12,day)).map(j=>j.id).sort(),['manual-0','manual-1','manual-2','manual-3']);
  await measure('paused_with_priority_index',true,3);
  // Diagnostic control: drop only this disposable schema's index, then roll back.
  await c.query('BEGIN');await c.query('DROP INDEX xc_auto_jobs_manual_due');
  try{await measure('paused_without_priority_index',true);}finally{await c.query('ROLLBACK');}
  await c.query('SET statement_timeout=120000');
  await c.query('UPDATE x_accounts SET account_busy_until=$1',[now+60000]);
  await c.query('ANALYZE x_accounts');
  await measure('all_accounts_busy',false);
  await c.query('UPDATE x_accounts SET account_busy_until=0');
  await c.query(`INSERT INTO xc_auto_jobs(id,account_name,expected_handle,kind,content,dedup,status,attempted,attempted_at,scheduled_at,created_at,origin)
   SELECT 'quota-'||i,'fixture_'||(i%100),'fixture_'||(i%100),'post','artificial quota fixture','quota-dedup-'||i,'published',true,$1,$1,$1,'agent' FROM generate_series(0,399) i`,[day]);
  await c.query('ANALYZE x_accounts; ANALYZE xc_auto_jobs');
  report.quotaScenarioExtraRows=400;
  await measure('all_agent_daily_quotas_exhausted',false);
  console.log('PASS: manual-first before LIMIT, pause guard, real runtime SQL, artificial data only');
 }finally{
  try{await c.query('ROLLBACK');if(created){await c.query('SET statement_timeout=120000');await c.query('DROP SCHEMA "'+schema+'" CASCADE');}}finally{await c.end();fs.writeFileSync(output,JSON.stringify(report,null,2));}
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
