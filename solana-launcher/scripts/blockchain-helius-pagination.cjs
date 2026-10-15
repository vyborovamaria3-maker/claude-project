#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
process.env.HELIUS_API_KEY = "fixture-key";
require("ts-node").register({skipProject:true,transpileOnly:true,
  compilerOptions:{module:"commonjs",moduleResolution:"node",esModuleInterop:true}});
const {fetchEnrichedTxsForMintWithMeta} = require("../lib/trade/helius");
const history = Array.from({length:105},(_,i)=>({
  signature:"signature-"+String(i+1).padStart(4,"0"),slot:10000-i,timestamp:100000-i
}));
const requests=[];
global.fetch = async (input) => {
  const u = new URL(String(input));
  requests.push(u);
  assert.equal(u.origin,"https://api-mainnet.helius-rpc.com");
  assert.equal(u.searchParams.get("commitment"),"finalized");
  assert.equal(u.searchParams.get("api-key"),"fixture-key");
  assert.equal(u.searchParams.has("before"),false,"legacy before key must not be used");
  const before=u.searchParams.get("before-signature");
  const index=before ? history.findIndex(tx=>tx.signature===before)+1 : 0;
  if(before && index===0) throw new Error("Unknown before-signature: "+before);
  const max=Number(u.searchParams.get("limit") || 100);
  return {ok:true,status:200,json:async()=>history.slice(index,index+max)};
};
(async()=>{
  let meta=await fetchEnrichedTxsForMintWithMeta("wallet-fixture",150,null,undefined,true);
  assert.equal(meta.transactions.length,105);
  assert.equal(meta.exhausted,true);
  assert.equal(meta.truncated,false);
  assert.equal(requests[1].searchParams.get("before-signature"),history[99].signature);
  assert.equal(requests[0].searchParams.get("token-accounts"),"balanceChanged");
  assert.equal(requests.length,3,"short page must be followed by empty page");
  requests.length=0;
  meta=await fetchEnrichedTxsForMintWithMeta("wallet-fixture",105,new Set([history[100].signature]),undefined,true);
  assert.equal(meta.transactions.length,101,"known overlap signature must be included for raw payload revisions");
  assert.equal(meta.transactions.at(-1).signature,history[100].signature);
  assert.equal(meta.reachedKnownHistory,true);
  assert.equal(meta.exhausted,false);
  requests.length=0;
  meta=await fetchEnrichedTxsForMintWithMeta("wallet-fixture",10,null,history[100].signature,true);
  assert.equal(meta.transactions.length,4);
  assert.equal(meta.exhausted,true);
  assert.equal(requests[0].searchParams.get("before-signature"),history[100].signature);
  console.log("[blockchain-helius-pagination] OK: correct REST cursor, 105 tx pages, incremental anchor, resumed backfill");
})().catch(e=>{console.error(e);process.exitCode=1;});
