const {connect}=require('./autopost/runtime.cjs');
const {TOPICS,readiness}=require('./discovery-core.cjs');
async function setup(c,runId,ids){
 if(!/^[a-f0-9-]{36}$/i.test(runId)||ids.length!==3||new Set(ids).size!==3||ids.some(id=>!/^\d{1,25}$/.test(id)))throw Error('Expected RUN_ID and exactly three distinct list IDs');
 await c.query('BEGIN');
 try{
  await c.query('SELECT pg_advisory_xact_lock(742098532)');
  const members=(await c.query('SELECT list_id FROM xc_history_lists WHERE run_id=$1',[runId])).rows;
  if(ids.some(id=>!members.some(m=>m.list_id===id)))throw Error('All three lists must belong to the archive run');
  const now=Date.now();
  for(const id of ids)await c.query('INSERT INTO xc_auto_sources(list_id,enabled) VALUES($1,true) ON CONFLICT(list_id) DO UPDATE SET enabled=true',[id]);
  await c.query('UPDATE xc_discovery_plan SET enabled=true,list_ids=$1::jsonb,history_run_id=$2,max_browser_accounts=1,updated_at=$3 WHERE id',[JSON.stringify(ids),runId,now]);
  for(const [name,query] of Object.entries(TOPICS))await c.query('INSERT INTO xc_discovery_sources(name,query) VALUES($1,$2) ON CONFLICT DO NOTHING',[name,query]);
  await c.query('COMMIT');
  return readiness(c);
 }catch(e){await c.query('ROLLBACK');throw e;}
}
if(require.main===module)(async()=>{const c=await connect();try{console.log(JSON.stringify(await setup(c,process.argv[2]||'',process.argv.slice(3))));}finally{await c.end();}})().catch(e=>{console.error(e.code?'Discovery configuration database error':e.message);process.exitCode=1;});
module.exports={setup};
