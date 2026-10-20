import test from "node:test";
import assert from "node:assert/strict";
import {readMintAccount,TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from "../src/analytics/solana-mint-rpc.js";

const mint="So11111111111111111111111111111111111111112";
const value=(type:string,owner:string=TOKEN_PROGRAM,program="spl-token")=>({
  executable:false,owner,
  data:{program,parsed:{type,info:{isInitialized:true,decimals:9}}},
});
const rpc=(account:unknown,extra:Record<string,unknown>={})=>({
  result:{context:{slot:321},value:account},...extra,
});
const stub=(body:unknown,status=200):typeof fetch=>(async(_url,init)=>{
  assert.equal(init?.redirect,"error");
  assert.equal(JSON.parse(String(init?.body)).params[1].encoding,"jsonParsed");
  return new Response(JSON.stringify(body),{status});
}) as typeof fetch;

test("Telegram Mint verification accepts ONLY parsed initialized SPL mint accounts",async()=>{
  assert.deepEqual(await readMintAccount("https://solana.example/rpc",mint,
    stub(rpc(value("mint")))),{decimals:9,owner:TOKEN_PROGRAM});
  assert.deepEqual(await readMintAccount("https://solana.example/rpc",mint,
    stub(rpc(value("mint",TOKEN_2022_PROGRAM,"spl-token-2022")))),
    {decimals:9,owner:TOKEN_2022_PROGRAM});
  for(const account of [
    value("account"),value("multisig"),value("mint",TOKEN_PROGRAM,"spl-token-2022"),
    {...value("mint"),executable:true},
    {...value("mint"),data:{program:"spl-token",parsed:{type:"mint",info:{isInitialized:false,decimals:9}}}},
    {...value("mint"),data:{program:"spl-token",parsed:{type:"mint",info:{isInitialized:true,decimals:31}}}},
    {owner:TOKEN_PROGRAM,executable:false,data:["A".repeat(165),"base64"]},
    {...value("mint"),owner:"11111111111111111111111111111111"},
  ]){
    assert.equal(await readMintAccount("https://solana.example/rpc",mint,stub(rpc(account))),null);
  }
  assert.equal(await readMintAccount("https://solana.example/rpc",mint,stub(rpc(null))),null);
});

test("Telegram RPC fails closed on malformed response and sanitized request configuration",async()=>{
  for(const bad of [
    "http://rpc.example",
    "https://user:password@rpc.example",
    "https://rpc.example/#fragment",
  ])await assert.rejects(readMintAccount(bad,mint,stub(rpc(value("mint")))));
  await assert.rejects(readMintAccount("https://rpc.example",mint,
    stub({error:{message:"SECRET"}})),/mint_rpc_response_invalid/);
  await assert.rejects(readMintAccount("https://rpc.example",mint,
    stub({result:{value:value("mint")}})),/mint_rpc_response_invalid/);
  await assert.rejects(readMintAccount("https://rpc.example",mint,
    stub(rpc(value("mint")),500)),/mint_rpc_transport_failed/);
  await assert.rejects(readMintAccount("https://rpc.example",mint,
    (async()=>new Response("{{bad json",{status:200})) as typeof fetch),
    /mint_rpc_response_invalid/);
});
