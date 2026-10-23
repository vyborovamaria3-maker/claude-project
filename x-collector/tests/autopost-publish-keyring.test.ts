import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const load=createRequire(__filename);
const keyring=load('../scripts/autopost/keyring.cjs');

test('legacy publisher entrypoints read legacy/V2 sessions and reject corruption before browser startup',{timeout:5000},async()=>{
 const old=randomBytes(32),future=randomBytes(32);
 const state={cookies:[{name:'auth_token',value:'offline-only'}],origins:[]};
 try{
  for(const filename of ['test-publish.cjs','x-publish-web.cjs'])for(const mode of ['legacy','v2','corrupt']){
   const env:Record<string,string>={MASTER_KEY:old.toString('hex'),X_COLLECTOR_ENCRYPTION_KEYS:JSON.stringify({future:future.toString('hex')})};
   if(mode!=='legacy')env.X_COLLECTOR_ACTIVE_KEY_ID='future';
   const blob=keyring.sealBytes(Buffer.from(JSON.stringify(state)),env);
   if(mode==='corrupt')blob[blob.length-1]^=1;
   let opened=0,observed:unknown;
   let finish!:()=>void;
   const done=new Promise<void>(resolve=>{finish=resolve;});
   class FakeClient{
    async connect(){}
    async query(){return {rows:[{role:'publisher',status:'active',session_encrypted:blob}]};}
    async end(){finish();}
   }
   const browser={async newContext(options:{storageState:unknown}){
    observed=options.storageState;
    return {async newPage(){return {async goto(){throw Error('OFFLINE_STOP_BEFORE_X');}};}};
   },async close(){}};
   const modules:Record<string,unknown>={
    'node:fs':{readFileSync:()=>''},'node:path':load('node:path'),
    pg:{Client:FakeClient},playwright:{chromium:{}},dotenv:{parse:()=>env},
    './test-publish-browser.cjs':{async launchLoginBrowser(){opened++;return {browser};}},
    './x-proxy.cjs':{parseProxy:()=>null},'./autopost/keyring.cjs':keyring,
   };
   vm.runInNewContext(readFileSync('scripts/'+filename,'utf8'),{
    require:(id:string)=>{assert(id in modules,'No unmocked module: '+id);return modules[id];},
    Buffer,console:{error(){},log(){}},
    process:{env:{},argv:['node',filename,'offline_fixture','offline'],connected:false,
     once(_event:string,callback:(input:unknown)=>void){callback({name:'offline_fixture',expected:'offline',text:'offline'});},
     on(){},send(){},cwd:()=>'.'},
   },{filename});
   await done;
   assert.equal(opened,mode==='corrupt'?0:1);
   if(mode!=='corrupt')assert.deepEqual(JSON.parse(JSON.stringify(observed)),state);
  }
 }finally{old.fill(0);future.fill(0);}
});
