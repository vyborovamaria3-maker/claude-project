import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
const {saveCheckedProxy}=createRequire(__filename)('../scripts/proxy-check.cjs');
test('saving an IPv6 proxy changes only the selected account and rejects stale, busy or failed checks',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE TABLE x_accounts(name TEXT PRIMARY KEY,proxy_json TEXT,updated_at BIGINT,account_busy_until BIGINT,health_score INT,last_check_json JSONB,last_check_at BIGINT)');
  await db.query("INSERT INTO x_accounts(name,proxy_json,updated_at,account_busy_until) VALUES ('first','original',10,0),('second','keep',20,0)");
  const c={query:async(sql:string,params:unknown[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.affectedRows};}};
  const result={ok:true,proxy:{type:'http',host:'[2001:db8::1]',port:8080,username:'user',password:'private',status:'connected',ip:'2001:db8::2'}};
  const saved=await saveCheckedProxy(c,{name:'first',version:'10'},result);
  assert.ok(!JSON.stringify(saved).includes('private'));
  const rows=(await db.query<{name:string;proxy_json:string;updated_at:string}>('SELECT * FROM x_accounts ORDER BY name')).rows;
  assert.deepEqual(JSON.parse(rows[0].proxy_json),result.proxy);assert.equal(rows[1].proxy_json,'keep');assert.equal(Number(rows[1].updated_at),20);
  await assert.rejects(saveCheckedProxy(c,{name:'first',version:'10'},result),/changed/);
  await db.query("UPDATE x_accounts SET account_busy_until=$1 WHERE name='first'",[Date.now()+60000]);
  await assert.rejects(saveCheckedProxy(c,{name:'first',version:String(rows[0].updated_at)},result),/busy/);
  await assert.rejects(saveCheckedProxy(c,{name:'second',version:'20'},{...result,ok:false}),/PROXY_FAILED/);
  assert.equal((await db.query<{proxy_json:string}>("SELECT proxy_json FROM x_accounts WHERE name='second'")).rows[0].proxy_json,'keep');
 }finally{await db.close();}
});
