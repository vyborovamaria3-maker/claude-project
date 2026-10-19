// V2-04: dedicated heartbeat connection; no X/network action is performed here.
const {randomUUID}=require('node:crypto');
const HEARTBEAT_MS=30_000;
const HEARTBEAT_TTL_MS=120_000;
const COMPONENT_STALL_MS=10*60_000;
const COMPONENTS=['planner','publisher','reconcile','sync'];
const COMPONENT_SET=new Set(COMPONENTS);

function summarizeWorkerHealth(worker,rows=[],now=Date.now()){
 const stamp=Number(worker?.heartbeat_at);
 const components=COMPONENTS.map(component=>{
  const found=rows.find(row=>row.component===component&&row.worker_id===worker?.worker_id);
  return {component,state:found?.state||'idle',last_started_at:found?.last_started_at??null,
   last_completed_at:found?.last_completed_at??null,last_error_code:found?.last_error_code??null};
 });
 const online=Number.isFinite(stamp)&&stamp>0&&now>=stamp&&now-stamp<=HEARTBEAT_TTL_MS;
 let state='offline';
 if(online){
  const active=components.filter(c=>c.state==='busy');
  state=active.some(c=>now-Number(c.last_started_at||0)>COMPONENT_STALL_MS)?'stalled':active.length?'busy':'idle';
 }
 return {state,worker_id:worker?.worker_id||null,heartbeat_at:worker?.heartbeat_at??null,
  started_at:worker?.started_at??null,components};
}
async function readWorkerHealth(c,now=Date.now()){
 const present=(await c.query("SELECT to_regclass('xc_auto_worker_health') AS present")).rows[0]?.present;
 const health=present
  ?(await c.query('SELECT worker_id,started_at::text,heartbeat_at::text FROM xc_auto_worker_health WHERE id=1')).rows[0]
  :null;
 const rows=present
  ?(await c.query('SELECT component,worker_id,state,last_started_at::text,last_completed_at::text,last_error_code FROM xc_auto_component_health')).rows
  :[];
 const state=summarizeWorkerHealth(health,rows,now);
 const queue=(await c.query(`SELECT
  count(*) FILTER (WHERE status='queued')::int AS queued,
  count(*) FILTER (WHERE status='running')::int AS running,
  count(*) FILTER (WHERE status='uncertain')::int AS uncertain,
  min(scheduled_at) FILTER (WHERE status='queued')::text AS oldest_queued_at
  FROM xc_auto_jobs`)).rows[0];
 const manual=(await c.query("SELECT count(*)::int AS count FROM xc_auto_reconcile WHERE status IN ('manual_review','manual_required')")).rows[0];
 return {...state,queue:{queued:queue?.queued??0,running:queue?.running??0,
  uncertain:queue?.uncertain??0,manual_review:manual?.count??0,
  oldest_queued_at:queue?.oldest_queued_at??null}};
}
async function writeComponent(c,workerId,component,state,errorCode=null,now=Date.now()){
 if(!COMPONENT_SET.has(component)||!['busy','idle','error'].includes(state))throw Error('Invalid health component');
 const code=state==='error'&&typeof errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,47}$/.test(errorCode)?errorCode:state==='error'?'UNKNOWN_ERROR':null;
 await c.query(`INSERT INTO xc_auto_component_health(component,worker_id,state,last_started_at,last_completed_at,last_error_code,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(component) DO UPDATE SET
 worker_id=excluded.worker_id,state=excluded.state,
 last_started_at=CASE WHEN excluded.state='busy' THEN excluded.last_started_at ELSE xc_auto_component_health.last_started_at END,
 last_completed_at=CASE WHEN excluded.state<>'busy' THEN excluded.last_completed_at ELSE xc_auto_component_health.last_completed_at END,
 last_error_code=excluded.last_error_code,updated_at=excluded.updated_at`,
 [component,workerId,state,state==='busy'?now:null,state==='busy'?null:now,code,now]);
}
async function withComponent(c,workerId,component,operation){
 if(!workerId)return operation();
 // Monitoring must never cause a second send or change the publishing result.
 try{await writeComponent(c,workerId,component,'busy');}catch{}
 try{
  const result=await operation();
  try{await writeComponent(c,workerId,component,'idle');}catch{}
  return result;
 }catch(error){
  const sqlState=typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?'DB_'+error.code:'';
  const code=sqlState||'COMPONENT_FAILED';
  try{await writeComponent(c,workerId,component,'error',code);}catch{}
  throw error;
 }
}
async function startHeartbeat(connect,{workerId=randomUUID(),intervalMs=HEARTBEAT_MS,now=Date.now}={}){
 let db=null,inFlight=null,stopping=false;
 async function beat(){
  if(stopping||inFlight)return inFlight;
  inFlight=(async()=>{
   try{
    if(!db){
     db=await connect({onError:()=>{ /* Connection is recreated on next failed tick. */ }});
     await db.query({text:'SET statement_timeout=3000',query_timeout:3000});
     await db.query({text:'SET lock_timeout=2000',query_timeout:3000});
    }
    const stamp=now();
    await db.query({text:`INSERT INTO xc_auto_worker_health(id,worker_id,started_at,heartbeat_at)
 VALUES(1,$1,$2,$2) ON CONFLICT(id) DO UPDATE SET
 worker_id=excluded.worker_id,
 started_at=CASE WHEN xc_auto_worker_health.worker_id=excluded.worker_id THEN xc_auto_worker_health.started_at ELSE excluded.started_at END,
 heartbeat_at=excluded.heartbeat_at`,values:[workerId,stamp],query_timeout:3000});
    // Backward compatible signal for older local dashboards, on the SAME dedicated client.
    await db.query({text:'UPDATE xc_auto_control SET heartbeat=$1 WHERE id=1',values:[stamp],query_timeout:3000});
   }catch{
    const previous=db;db=null;
    if(previous)await previous.end().catch(()=>{});
   }
  })();
  try{await inFlight;}finally{inFlight=null;}
 }
 await beat();
 const timer=setInterval(()=>{void beat();},intervalMs);
 timer.unref?.();
 return {workerId,beat,async stop(){
  stopping=true;clearInterval(timer);
  if(inFlight)await inFlight.catch(()=>{});
  if(db)try{
   await db.query({text:'UPDATE xc_auto_worker_health SET heartbeat_at=0 WHERE id=1 AND worker_id=$1',values:[workerId],query_timeout:3000});
  }catch{}
  await db?.end().catch(()=>{});db=null;
 }};
}
module.exports={HEARTBEAT_MS,HEARTBEAT_TTL_MS,COMPONENT_STALL_MS,COMPONENTS,
 summarizeWorkerHealth,readWorkerHealth,writeComponent,withComponent,startHeartbeat};
