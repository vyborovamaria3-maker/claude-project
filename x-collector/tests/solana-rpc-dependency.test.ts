import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Connection} from '@solana/web3.js';
import {createRequire} from 'node:module';

test('patched Solana RPC dependency supports CommonJS, generated IDs, batch and error responses',async()=>{
 const load=createRequire(__filename);
 const sdkLoad=createRequire(load.resolve('@solana/web3.js'));
 const jaysonLoad=createRequire(sdkLoad.resolve('jayson'));
 assert.equal(jaysonLoad('./package.json').version,'5.0.0');
 const BrowserClient=sdkLoad('jayson/lib/client/browser');
 const client=new BrowserClient((body:string,cb:(error:null,response:string)=>void)=>{
  const req=JSON.parse(body);cb(null,JSON.stringify(Array.isArray(req)?req.map(r=>({jsonrpc:'2.0',id:r.id,result:1})):{jsonrpc:'2.0',id:req.id,result:1}));
 });
 const request=client.request('getSlot',[]);
 assert.equal(typeof request.id,'string');assert(request.id.length>0);
 const requests=[request,client.request('getBlockHeight',[])];assert.notEqual(requests[0].id,requests[1].id);
 await new Promise<void>((resolve,reject)=>client.request(requests,(err:Error|null,result:unknown[])=>{if(err)return reject(err);assert.equal(result.length,2);resolve();}));
 let rpcError=false;
 const connection=new Connection('http://127.0.0.1:1',{fetch:async(_input,init)=>{
  const req=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,...(rpcError?{error:{code:-32602,message:'invalid fixture request'}}:{result:123})}),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.equal(await connection.getSlot(),123);
 rpcError=true;await assert.rejects(connection.getSlot(),/invalid fixture request/);
});
