import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';

// Playwright-compatible, network-free page mocks. No X action is sent.
const load=createRequire(__filename);
const {reconcileAction}=load('../scripts/autopost/browser.cjs');

type ActionKind='like'|'repost'|'follow';
type Observation={performed?:boolean;available?:boolean;observedHandle?:string;redirect?:boolean;missing?:boolean;permalink?:string};

function fakeBrowser(kind:ActionKind,observation:Observation={}){
 const {performed=false,available=false,observedHandle='target',redirect=false,missing=false,permalink='/target/status/123'}=observation;
 const listeners=new Set<(response:unknown)=>void>();
 const calls:string[]=[];
 const counter=(selector:string)=>({
  count:async()=>Number(
   /(?:unlike|unretweet|-unfollow)/.test(selector)?performed:available
  ),
  click:async()=>{throw Error('Read-only observation attempted to click an X action');},
 });
 const anchor:any={filter:()=>anchor,first:()=>anchor,getAttribute:async()=>permalink};
 const article:any={
  filter:()=>article,first:()=>article,
  waitFor:async()=>{if(missing)throw Error('target unavailable');},
  locator:(selector:string)=>selector==='a'?anchor:counter(selector),
 };
 const area:any={
  waitFor:async()=>{if(missing)throw Error('target unavailable');},
  locator:(selector:string)=>counter(selector),
 };
 const noop:any={filter:()=>noop,first:()=>noop};
 const page:any={
  on:(_event:string,listener:(response:unknown)=>void)=>listeners.add(listener),
  off:(_event:string,listener:(response:unknown)=>void)=>listeners.delete(listener),
  url:()=>redirect?'https://x.com/other':'https://x.com/target',
  waitForTimeout:async()=>{},
  locator:(selector:string)=>{
   if(selector==='article')return article;
   if(selector==='[data-testid="primaryColumn"]')return area;
   return noop;
  },
  goto:async(url:string)=>{
   calls.push('goto:'+url);
   const body=kind==='follow'
    ?{data:{user:{rest_id:'42',legacy:{screen_name:observedHandle}}}}
    :{data:{tweet:{rest_id:'123',legacy:{full_text:'a tweet'},core:{user_results:{result:{legacy:{screen_name:observedHandle}}}}}}};
   const response={status:()=>200,url:()=> 'https://x.com/i/api/graphql/ReadOnly',json:async()=>body};
   for(const listener of listeners)listener(response);
  },
 };
 return {page,calls,browser:{close:async()=>calls.push('closed')}};
}
async function observe(kind:ActionKind,observation:Observation={}){
 const opened=fakeBrowser(kind,observation);
 const job={id:'00000000-0000-4000-8000-000000000001',kind,account_name:'test-account',expected_handle:'publisher',target_handle:'target',target_id:'123'};
 const result=await reconcileAction({},job,async(_db:unknown,account:string,handle:string)=>{
  assert.equal(account,'test-account');
  assert.equal(handle,'publisher','Must validate authorized publisher session');
  return opened;
 });
 assert.equal(opened.calls.at(-1),'closed','Browser must close after every observation');
 assert.deepEqual(opened.calls.slice(0,-1),['goto:https://x.com/target'+(kind==='follow'?'':'/status/123')]);
 return result;
}
for(const kind of ['like','repost','follow'] as const){
 test(kind+': confirmed action state resolves without sending an X action',async()=>{
  assert.deepEqual(await observe(kind,{performed:true}),{status:'performed'});
 });
 test(kind+': negative and unobservable states never confirm an action',async()=>{
  assert.deepEqual(await observe(kind,{available:true}),{status:'not_performed'});
  assert.deepEqual(await observe(kind),{status:'unknown'});
  assert.deepEqual(await observe(kind,{performed:true,available:true}),{status:'unknown'});
 });
 if(kind!=='follow')test(kind+': foreign target cannot be confirmed',async()=>{
  assert.deepEqual(await observe(kind,{performed:true,observedHandle:'another_user'}),{status:'unknown'});
 });
}
test('follow: GraphQL evidence from another user is not the target identity',()=>{
 const {extractUser}=load('../scripts/autopost/browser.cjs');
 assert.equal(extractUser({data:{user:{rest_id:'42',legacy:{screen_name:'someone_else'}}}},'target'),null);
});
test('follow: a redirected profile cannot be mistaken for the intended target',async()=>{
 assert.deepEqual(await observe('follow',{performed:true,redirect:true}),{status:'unknown'});
});
test('like/repost: wrong exact permalink cannot confirm an action',async()=>{
 for(const kind of ['like','repost'] as const)
  assert.deepEqual(await observe(kind,{performed:true,permalink:'/target/status/999'}),{status:'unknown'});
});
test('unavailable target cannot be auto-confirmed or clicked',async()=>{
 for(const kind of ['like','repost','follow'] as const){
  const opened=fakeBrowser(kind,{performed:true,missing:true});
  await assert.rejects(reconcileAction({}, {kind,account_name:'test-account',expected_handle:'publisher',target_handle:'target',target_id:'123'},async()=>opened),/target unavailable/);
  assert.equal(opened.calls.at(-1),'closed');
 }
});
test('invalid target identity never starts a browser',async()=>{
 let opened=false;
 assert.deepEqual(await reconcileAction({}, {kind:'follow',account_name:'test-account',expected_handle:'publisher',target_handle:'invalid/name'},async()=>{opened=true;}),{status:'unknown'});
 assert.equal(opened,false);
});

test('pre-send target guard rejects renamed authors, redirect paths and wrong tweet IDs',()=>{
 const {verifiedTargetLink,verifiedProfileLink}=load('../scripts/autopost/browser.cjs');
 assert.equal(verifiedTargetLink('/Alice/status/12345','alice','12345'),true);
 assert.equal(verifiedProfileLink('/Alice','alice'),true);
 for(const href of ['/bob/status/12345','/alice/status/999','https://evil.example/alice/status/12345','/alice/status/12345/extra']){
  assert.throws(()=>verifiedTargetLink(href,'alice','12345'),/TARGET_NOT_FOUND/);
 }
 for(const href of ['/bob','https://evil.example/alice','/alice/status/12345']){
  assert.throws(()=>verifiedProfileLink(href,'alice'),/TARGET_NOT_FOUND/);
 }
});
