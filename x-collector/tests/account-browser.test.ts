import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test,mock} from 'node:test';
const load=createRequire(__filename);
const browserModule=load.resolve('../scripts/autopost/browser.cjs');
const helper=load('../scripts/test-publish-browser.cjs');
const runtime=load('../scripts/autopost/runtime.cjs');

test('authenticated SOCKS5 uses a local browser bridge and closes it on disconnect or launch failure',async()=>{
 const chain=load('proxy-chain/dist/anonymize_proxy');
 let upstream='',closed=0,disconnect:()=>void=()=>{};
 const a=mock.method(chain,'anonymizeProxy',async(url:string)=>{upstream=url;return 'http://127.0.0.1:12345';});
 const b=mock.method(chain,'closeAnonymizedProxy',async()=>{closed++;});
 try{
  const chromium={launch:async(options:any)=>{assert.deepEqual(options.proxy,{server:'http://127.0.0.1:12345'});return {once:(_event:string,fn:()=>void)=>{disconnect=fn;}};}};
  const proxy={server:'socks5://localhost:1080',username:'user',password:'p@ss'};
  await helper.launchLoginBrowser(chromium,{X_LOGIN_BROWSER:'chrome'},{proxy,headless:true});
  assert.equal(new URL(upstream).password,'p%40ss');
  disconnect();await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
  await assert.rejects(helper.launchLoginBrowser({launch:async()=>{throw Error('failed');}},{X_LOGIN_BROWSER:'chrome'},{proxy}),/browsermissing/);
  assert.equal(closed,2);
 }finally{a.mock.restore();b.mock.restore();}
});
test('publisher refuses expired sessions and malformed/recently failed proxies before browser launch',async()=>{
 let launches=0;
 const m=mock.method(helper,'launchLoginBrowser',async()=>{launches++;throw Error('unexpected browser');});
 try{
  delete load.cache[browserModule];const {open}=load(browserModule);
  for(const [row,code] of [
   [{last_check_json:{errorType:'SESSION_EXPIRED'}},'SESSION_EXPIRED'],
   [{proxy_json:'not JSON'},'PROXY_FAILED'],
   [{proxy_json:JSON.stringify({type:'http',host:'localhost',port:1234,status:'failed',last_check:Date.now()})},'PROXY_FAILED']
  ] as const){await assert.rejects(open({query:async()=>({rows:[row]})},'publisher','expected'),new RegExp(code));}
  assert.equal(launches,0);
 }finally{m.mock.restore();delete load.cache[browserModule];}
});
test('publishing browser receives the selected account IPv6 proxy and profile settings',async()=>{
 const page={goto:async()=>{},locator:()=>({first:()=>({waitFor:async()=>{},getAttribute:async()=>'/expected'})})};
 let contextOptions:Record<string,unknown>|undefined;
 const browser={newContext:async(options:Record<string,unknown>)=>{contextOptions=options;return {newPage:async()=>page};},close:async()=>{}};
 const a=mock.method(helper,'launchLoginBrowser',async(_chromium:unknown,_env:unknown,options:{proxy:unknown})=>{
  assert.deepEqual(options.proxy,{server:'http://[2001:db8::1]:8080',username:'user',password:'private'});return {browser};
 });
 const b=mock.method(runtime,'unseal',()=>JSON.stringify({cookies:[],origins:[]}));
 const d=mock.method(runtime,'config',()=>({}));
 try{
  delete load.cache[browserModule];const {open}=load(browserModule);
  const account={session_encrypted:Buffer.from('fixture'),proxy_json:JSON.stringify({type:'http',host:'2001:db8::1',port:8080,username:'user',password:'private'}),user_agent:'Fixture UA',timezone:'Europe/Moscow',language:'ru-RU'};
  await open({query:async()=>({rows:[account]})},'publisher','expected');
  await open({query:async()=>({rows:[{...account,proxy_json:'http://user:private@[2001:db8::1]:8080'}]})},'publisher','expected');
  assert.equal(contextOptions?.userAgent,'Fixture UA');assert.equal(contextOptions?.timezoneId,'Europe/Moscow');assert.equal(contextOptions?.locale,'ru-RU');
 }finally{a.mock.restore();b.mock.restore();d.mock.restore();delete load.cache[browserModule];}
});
