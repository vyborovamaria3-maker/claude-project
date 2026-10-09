import { spawnSync } from 'node:child_process';
import { test,mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { closePool,tx } from '../lib/trade/pg';
import { source,storePage } from '../lib/archive/store';
import { Page } from '../lib/archive/model';
import { exportInputs,registerModel,saveResult,inputHash } from '../lib/ai/data';
test('bulk archive bounds SQL calls and AI exports preserve cutoff, nullable metrics and immutable model versions',async()=>{
 const db=new PGlite(),old=process.env.DATABASE_URL;process.env.DATABASE_URL='postgresql://fixture/ai_test';
 let queries=0;
 const query=async(sql:string,params:unknown[]=[])=>{queries++;const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};};
 const a=mock.method(Pool.prototype,'query',query),b=mock.method(Pool.prototype,'connect',async()=>({query,release(){},on(){}}));
 try{
  for(const name of ['014_archive.sql','018_ai_foundation.sql'])await db.exec(await fs.readFile('migrations/'+name,'utf8'));
  const id=await source('Controlled fixture','https://example.org/fixture','test fixture','tweets');
  const first=Page.parse({data:Array.from({length:200},(_,n)=>({id:String(100000+n),text:'old text',created_at:'2025-01-01T00:00:00Z',metrics_observed_at:'2025-01-02T00:00:00Z',public_metrics:{like_count:0}}))});
  queries=0;const baselineStart=performance.now();
  await tx(async c=>{
   for(let n=0;n<200;n++){
    await c.query("INSERT INTO archive_posts(id,text,posted_at,first_received_at,last_received_at) VALUES($1,'old text','2024-01-01','2024-01-02','2024-01-02')",[String(900000+n)]);
    await c.query("INSERT INTO archive_metrics(post_id,source_id,received_at,metrics_observed_at,likes,raw_hash,snapshot_key) VALUES($1,$2,'2024-01-02','2024-01-02',0,$3,$3)",[String(900000+n),id,'d'.repeat(64)]);
   }
   await c.query("INSERT INTO archive_raw_pages(hash,source_id,path,received_at) VALUES($1,$2,'controlled-fixture','2024-01-02')",['d'.repeat(64),id]);
  });
  const baselineQueries=queries,baselineMs=performance.now()-baselineStart;
  assert.equal(baselineQueries,403);
  queries=0;const before=performance.now();
  await tx(c=>storePage(c,id,first,{hash:'a'.repeat(64),path:'controlled-fixture'},new Date('2025-01-02T01:00:00Z'),null));
  assert.equal(queries,6); // BEGIN, posts, versions, metrics, raw-page, COMMIT.
  console.log(`200-post fixture: row-wise minimum ${baselineQueries} SQL calls / ${baselineMs.toFixed(1)} ms; bulk with version history ${queries} calls / ${(performance.now()-before).toFixed(1)} ms (PGlite, not live X throughput)`);
  const changed=Page.parse({data:[{id:'100000',text:'edited text',created_at:'2025-01-01T00:00:00Z',metrics_observed_at:'2025-01-05T00:00:00Z',public_metrics:{like_count:900}}]});
  await tx(c=>storePage(c,id,changed,{hash:'b'.repeat(64),path:'controlled-fixture'},new Date('2025-01-05T01:00:00Z'),null));
  // Received after cutoff despite an earlier observation: must not leak into training.
  const delayed=Page.parse({data:[{id:'100000',text:'delayed text',created_at:'2025-01-01T00:00:00Z',metrics_observed_at:'2025-01-02T12:00:00Z',public_metrics:{like_count:42}}]});
  await tx(c=>storePage(c,id,delayed,{hash:'c'.repeat(64),path:'controlled-fixture'},new Date('2025-01-06T00:00:00Z'),null));
  await db.query("INSERT INTO archive_posts(id,text,posted_at,first_received_at,last_received_at) VALUES('00001','legacy','2025-01-01','2025-01-02','2025-01-02')");
  const oldRows=[];for await(const row of exportInputs({from:'2025-01-01T00:00:00Z',to:'2025-02-01T00:00:00Z',asOf:'2025-01-03T00:00:00Z',batch:1}))oldRows.push(row);
  assert.equal(oldRows.length,200);assert.equal(oldRows[0].text,'old text');assert.equal(oldRows[0].likes,'0');assert.equal(oldRows[0].views,null);assert.equal(oldRows[0].input_hash,inputHash('old text'));
  const future=[];for await(const row of exportInputs({from:'2025-01-01T00:00:00Z',to:'2025-02-01T00:00:00Z',asOf:'2025-01-07T00:00:00Z'}))future.push(row);
  assert.equal(future[0].text,'delayed text');assert.equal(future[0].likes,'900');
  await registerModel({name:'fixture',version:'1',task:'embedding',dimensions:2});
  await registerModel({name:'fixture',version:'1',task:'embedding',dimensions:2});
  await assert.rejects(registerModel({name:'fixture',version:'1',task:'embedding',dimensions:3}),/different configuration/);
  const result={postId:oldRows[0].post_id,sourceId:oldRows[0].source_id,rawHash:oldRows[0].raw_hash,modelName:'fixture',modelVersion:'1',inputHash:oldRows[0].input_hash,result:{label:'controlled'},embedding:[0.1,0.2]};
  await saveResult(result);await saveResult(result);
  await assert.rejects(saveResult({...result,embedding:[1]}),/dimensions/);
  await assert.rejects(saveResult({...result,inputHash:inputHash('wrong')}),/input hash/);
  await assert.rejects(saveResult({...result,result:{label:'different'}}),/already exists/);
  assert.equal((await db.query('SELECT * FROM ai_post_results')).rows.length,1);
 }finally{await closePool();a.mock.restore();b.mock.restore();await db.close();if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;}
});

test('AI export validation keeps stdout free of dotenv banners and reports failure on stderr',()=>{
 const run=spawnSync(process.execPath,['--import','tsx','scripts/ai/export.ts','--from','invalid'],{encoding:'utf8'});
 assert.equal(run.status,1);assert.equal(run.stdout,'');assert.match(run.stderr,/AI export failed/);
});
