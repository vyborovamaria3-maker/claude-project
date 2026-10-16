"use strict";
const assert=require("node:assert/strict");
const alchemy=require("./blockchain-alchemy-provider.cjs");

const accounts=alchemy.parseAccounts({
  ALCHEMY_SOLANA_API_KEY_1:"a1",ALCHEMY_SOLANA_API_KEY_2:"a2",
  ALCHEMY_SOLANA_CU_USED_BASELINE_1:"1000",ALCHEMY_SOLANA_BILLING_RESET_DAY_1:"1",
  ALCHEMY_SOLANA_CU_USED_BASELINE_2:"0",ALCHEMY_SOLANA_BILLING_RESET_DAY_2:"16",
});
assert.equal(accounts.length,2);
assert.equal(accounts[0].monthlyBudgetCu,30000000);
assert.equal(alchemy.getMethodCost("getTransactionsForAddress",{}),100);
assert.equal(alchemy.getMethodCost("getTransaction",{}),40);
assert.equal(alchemy.currentBillingMonthKey(Date.UTC(2026,9,15),1),"2026-10");
assert.equal(alchemy.currentBillingMonthKey(Date.UTC(2026,9,15),16),"2026-09-16");
assert.equal(alchemy.currentBillingMonthKey(Date.UTC(2026,9,16),16),"2026-10-16");
assert.equal(alchemy.currentBillingMonthKey(Date.UTC(2026,1,27),31),"2026-01-31");
assert.equal(alchemy.currentBillingMonthKey(Date.UTC(2026,1,28),31),"2026-02-28");
const missingBaselineProvider=alchemy.createProvider({env:{ALCHEMY_SOLANA_API_KEY_1:"x"},fetch:async()=>{throw new Error("should not reach network");}});
assert.equal(missingBaselineProvider.accounts.length,1);
assert.throws(()=>alchemy.parseAccounts({ALCHEMY_SOLANA_API_KEY_1:"x",ALCHEMY_SOLANA_CU_USED_BASELINE_1:"0",ALCHEMY_SOLANA_BILLING_RESET_DAY_1:"0"}),/BILLING_RESET_DAY_1/);
assert.throws(()=>alchemy.getMethodCost("getTransactionsForAddress",{ALCHEMY_SOLANA_CU_COST_getTransactionsForAddress:"0"}),/positive integer/);

const raw={
  signature:"sig-fixture",slot:123,blockTime:1700000000,
  transaction:{signatures:["sig-fixture"],message:{accountKeys:["owner-A","token-account-A"]}},
  meta:{err:null,fee:5000,
    preTokenBalances:[{accountIndex:1,mint:"mint-A",owner:"owner-A",uiTokenAmount:{amount:"100",decimals:2,uiAmountString:"1"}}],
    postTokenBalances:[{accountIndex:1,mint:"mint-A",owner:"owner-A",uiTokenAmount:{amount:"75",decimals:2,uiAmountString:"0.75"}}]},
};
const normalized=alchemy.normalizeRawTransaction(raw);
assert.equal(normalized.signature,"sig-fixture");
assert.equal(normalized.timestamp,1700000000);
assert.equal(normalized.fee,5000);
assert.deepEqual(normalized.tokenBalanceChanges,[{mint:"mint-A",owner:"owner-A",accountIndex:1,decimals:2,rawAmountDelta:"-25"}]);
assert.equal(normalized.tokenTransfers.length,0,"balance deltas are not proof of a transfer");
assert.equal(normalized.nativeTransfers.length,0,"lamport deltas are not proof of a transfer");

(async()=>{
  const seen=[];
  const provider=alchemy.createProvider({
    env:{
      ALCHEMY_SOLANA_API_KEY_1:"a1",ALCHEMY_SOLANA_CU_USED_BASELINE_1:"0",ALCHEMY_SOLANA_BILLING_RESET_DAY_1:"1",
    },
    fetch:async(url,init)=>{
      seen.push({url,body:JSON.parse(init.body)});
      return {ok:true,status:200,json:async()=>({result:{transactions:[raw],paginationToken:null}})};
    }
  });
  let reserved=0,responded=0;
  const page=await provider.fetchPage("address-A",null,100,{
    beforeRequest:async ctx=>{assert.equal(ctx.method,"getTransactionsForAddress");assert.equal(ctx.estimatedCu,100);reserved++;return "reservation-1";},
    afterResponse:async(id,ctx)=>{assert.equal(id,"reservation-1");assert.equal(ctx.status,200);responded++;},
  });
  assert.equal(page.provider,"alchemy");
  assert.equal(page.accountId,"alchemy-1");
  assert.equal(page.transactions[0].signature,"sig-fixture");
  assert.equal(page.exhausted,true);
  assert.equal(reserved,1);assert.equal(responded,1);assert.equal(seen.length,1);
  const encoded=alchemy.encodeCursor("page-token-1");
  assert.equal(alchemy.decodeCursor(encoded),"page-token-1");
  assert.equal(alchemy.decodeCursor("signature-anchor"),null);
  await assert.rejects(()=>missingBaselineProvider.fetchPage("address-A",null,100),/CU_USED_BASELINE_1/);
  assert.match(seen[0].url,/solana-mainnet\.g\.alchemy\.com\/v2\/a1$/);
  assert.equal(seen[0].body.method,"getTransactionsForAddress");

  const rawSig=(signature,slot)=>({...raw,signature,slot,transaction:{...raw.transaction,signatures:[signature]}});
  const cursorPages=[
    {result:{transactions:[rawSig("newer",1),rawSig("anchor-signature",2)],paginationToken:"older-page"}},
    {result:{transactions:[rawSig("older",3)],paginationToken:null}},
  ];
  let cursorCall=0;
  const cursorProvider=alchemy.createProvider({env:{
    ALCHEMY_SOLANA_API_KEY_1:"cursor-key",ALCHEMY_SOLANA_CU_USED_BASELINE_1:"0",ALCHEMY_SOLANA_BILLING_RESET_DAY_1:"1"
  },fetch:async()=>({ok:true,status:200,json:async()=>cursorPages[cursorCall++]})});
  const resumed=await cursorProvider.fetchHistoryWithMeta("address-A",10,null,"anchor-signature",false,{
    beforeRequest:async()=> "r",afterResponse:async()=>{},onError:async()=>{}
  });
  assert.deepEqual(resumed.transactions.map(x=>x.signature),["older"],"a Helius signature cursor resumes strictly after the anchor");
  assert.equal(resumed.exhausted,true);

  let budgetCalls=0;
  const partialProvider=alchemy.createProvider({env:{
    ALCHEMY_SOLANA_API_KEY_1:"partial-key",ALCHEMY_SOLANA_CU_USED_BASELINE_1:"0",ALCHEMY_SOLANA_BILLING_RESET_DAY_1:"1"
  },fetch:async()=>({ok:true,status:200,json:async()=>({result:{transactions:[rawSig("first-page",10)],paginationToken:"next-page"}})})});
  const partial=await partialProvider.fetchHistoryWithMeta("address-A",200,null,undefined,false,{
    beforeRequest:async()=>{budgetCalls++;if(budgetCalls===2){const error=new Error("pilot cap");error.code="ALCHEMY_PILOT_CU_BUDGET_EXCEEDED";throw error;}return "r";},
    afterResponse:async()=>{},onError:async()=>{}
  });
  assert.equal(partial.transactions.length,1);
  assert.equal(partial.budgetExhausted,true);
  assert.equal(alchemy.decodeCursor(partial.nextCursor),"next-page","partial data retains the next-page cursor");

  console.log("[blockchain-alchemy-provider-regression] OK: key registry, per-account baseline validation, CU method costs, UTC billing windows, raw balance deltas, mock history, signature-anchor resume and partial-budget checkpoint");
})().catch(error=>{console.error(error);process.exitCode=1;});
