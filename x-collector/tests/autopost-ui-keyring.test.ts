import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const load=createRequire(__filename);
const {unsealBytes}=load('../scripts/autopost/keyring.cjs');
const {kind}=load('../scripts/autopost/key-rotation-core.cjs');

test('actual UI account writer honors legacy/V2 keyring and fails closed before any DB write',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'v207-ui-fixture-')),envFile=path.join(root,'fixture.env');
 const old=randomBytes(32),future=randomBytes(32);
 const launcher=path.resolve('../solana-launcher');
 const source=await fs.readFile(path.join(launcher,'lib/xcollector-accounts.ts'),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const session=JSON.stringify({cookies:['auth_token','ct0'].map(name=>({name,value:'offline-test-only',domain:'.x.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'})),origins:[]});
 try{
  for(const mode of ['legacy','v2','unknown_active','missing_legacy']){
   const env:Record<string,string>={X_COLLECTOR_ENV:envFile};
   const fileEnv:Record<string,string>={DATABASE_URL:'postgresql://offline@127.0.0.1:1/v207_test'};
   if(mode!=='missing_legacy')fileEnv.MASTER_KEY=old.toString('hex');
   if(mode!=='legacy'){
    env.X_COLLECTOR_ENCRYPTION_KEYS=JSON.stringify({future:future.toString('base64')});
    env.X_COLLECTOR_ACTIVE_KEY_ID=mode==='unknown_active'?'missing':'future';
   }
   await fs.writeFile(envFile,Object.entries(fileEnv).map(([k,v])=>k+'='+v).join('\n'));
   let encrypted:Buffer|undefined,writes=0;
   class FakePool{
    on(){return this;}
    async query(sql:string,params:unknown[]=[]){
     if(sql.includes('information_schema.columns'))return {rows:[{present:1}]};
     assert(sql.startsWith('INSERT INTO x_accounts'));writes++;encrypted=Buffer.from(params[1] as Buffer);
     return {rows:[]};
    }
   }
   const module={exports:{}};
   vm.runInNewContext(js,{module,exports:module.exports,Buffer,require:(id:string)=>id==='pg'?{Pool:FakePool}:load(id),process:{env,cwd:()=>launcher,getBuiltinModule:process.getBuiltinModule}},{filename:'xcollector-accounts.js'});
   const api=module.exports as {addCollectorAccount:(input:unknown)=>Promise<unknown>};
   if(mode==='unknown_active'||mode==='missing_legacy'){
    await assert.rejects(api.addCollectorAccount({name:'offline_fixture',session}),mode==='unknown_active'?/ACTIVE_KEY_UNAVAILABLE/:/MASTER_KEY/);
    assert.equal(writes,0);continue;
   }
   await api.addCollectorAccount({name:'offline_fixture',session,role:'publisher'});
   assert.equal(writes,1);assert(encrypted);
   assert.equal(kind(encrypted),mode);
   assert.equal(unsealBytes(encrypted,{...env,...fileEnv}).toString('utf8'),session);
  }
 }finally{old.fill(0);future.fill(0);await fs.unlink(envFile).catch(()=>{});await fs.rmdir(root);}
});
