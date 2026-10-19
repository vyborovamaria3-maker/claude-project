import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import type {TelegramClient} from "telegram";
import {publicDiscoveryChannel} from "../src/validation.js";
test("only public channels and supergroups qualify",()=>{
 const c={className:'Channel',id:123,username:'crypto_news',broadcast:true};
 assert.ok(publicDiscoveryChannel(c));assert.ok(publicDiscoveryChannel({...c,broadcast:false,megagroup:true}));
 for(const x of [{...c,className:'User'},{...c,username:undefined},{...c,className:'ChannelForbidden'},{...c,broadcast:false},{...c,id:-1}])assert.equal(publicDiscoveryChannel(x),null);
});
test("PostgreSQL discovery budgets, queue, Stop, deletion tombstones and FloodWait",{skip:!process.env.DATABASE_URL},async()=>{
 const {pool,migrate}=await import('../src/db.js');await migrate();
 const {discoverPublicSources}=await import('../src/runtime/discovery.js');
 const prefix='disc_'+randomUUID().replaceAll('-','').slice(0,12),base=BigInt(Date.now())*1000n;
 const item=(i:number)=>({className:'Channel',id:base+BigInt(i),username:prefix+'_'+i,title:'Meme coins',broadcast:true});
 let calls=0;const fake=(fn:()=>Promise<unknown>)=>({invoke:async()=>{calls++;return fn()}} as unknown as Pick<TelegramClient,'invoke'>);
 const ready=()=>pool.query('UPDATE tg_discovery_settings SET next_run_at=now() WHERE id=1');
 const count=async(i:number)=>(await pool.query('SELECT count(*)::int AS n FROM tg_sources WHERE identifier=$1',[item(i).username])).rows[0].n;
 try{
  await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1');
  await pool.query("UPDATE tg_discovery_settings SET enabled=TRUE,keywords=ARRAY['memecoin','solana'],max_sources=1000,max_new_per_day=1,max_queries_per_day=24,queries_per_cycle=1,next_run_at=now(),keyword_cursor=0 WHERE id=1");
  await pool.query("DELETE FROM tg_discovery_daily WHERE day=(now() AT TIME ZONE 'UTC')::date");
  await pool.query('INSERT INTO tg_sources(identifier,peer_id,enabled) VALUES($1,$2,FALSE)',[item(0).username,item(0).id.toString()]);
  const client=fake(async()=>({chats:[item(0),item(1),item(2),{className:'User'}]}));
  await discoverPublicSources(client,()=>false);assert.equal(calls,1);assert.equal(await count(1),1);assert.equal(await count(2),0);
  assert.equal((await pool.query('SELECT enabled FROM tg_sources WHERE identifier=$1',[item(0).username])).rows[0].enabled,false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tg_jobs j JOIN tg_sources s ON s.id=j.source_id WHERE s.identifier=$1',[item(1).username])).rows[0].n,1);
  await ready();await discoverPublicSources(client,()=>false);assert.equal(calls,1,'daily additions cap persists');
  await pool.query('UPDATE tg_discovery_settings SET max_new_per_day=3,max_queries_per_day=1 WHERE id=1');
  await ready();await discoverPublicSources(client,()=>false);assert.equal(calls,1,'request cap persists');
  await pool.query('UPDATE tg_discovery_settings SET max_queries_per_day=24 WHERE id=1');
  await ready();await discoverPublicSources(fake(async()=>{await pool.query('UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1');return {chats:[item(3)]}}),()=>false);
  assert.equal(await count(3),0,'Stop during RPC prevents source writes');await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1');
  await pool.query('DELETE FROM tg_sources WHERE identifier=$1',[item(1).username]);await ready();
  await discoverPublicSources(fake(async()=>({chats:[item(1)]})),()=>false);assert.equal(await count(1),0,'removed sources stay removed');
  await pool.query('UPDATE tg_discovery_settings SET max_sources=(SELECT count(*) FROM tg_sources) WHERE id=1');
  const before=calls;await ready();await discoverPublicSources(client,()=>false);assert.equal(calls,before,'total cap prevents RPC');
  await pool.query('UPDATE tg_discovery_settings SET max_sources=1000 WHERE id=1');await ready();
  await discoverPublicSources(fake(async()=>{throw {errorMessage:'FLOOD_WAIT_2',code:420,seconds:2}}),()=>false);
  assert.equal((await pool.query('SELECT pause_until>now() AS paused FROM tg_runtime WHERE id=1')).rows[0].paused,true);
  await pool.query('UPDATE tg_runtime SET pause_until=NULL WHERE id=1');await ready();
  assert.equal(await discoverPublicSources(fake(async()=>{throw {errorMessage:'AUTH_KEY_UNREGISTERED'}}),()=>false),'halt');
 }finally{
  await pool.query('DELETE FROM tg_sources WHERE identifier LIKE $1',[prefix+'%']);await pool.query('DELETE FROM tg_discovered_sources WHERE username LIKE $1',[prefix+'%']);
  await pool.query("DELETE FROM tg_discovery_daily WHERE day=(now() AT TIME ZONE 'UTC')::date");
  await pool.query('UPDATE tg_discovery_settings SET enabled=FALSE,max_sources=30,max_new_per_day=3,max_queries_per_day=24 WHERE id=1');
  await pool.query('UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1');await pool.end();
 }
});
