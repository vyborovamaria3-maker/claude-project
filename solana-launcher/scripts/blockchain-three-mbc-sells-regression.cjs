"use strict";
const assert=require('node:assert/strict');
const {normalizeFullTransaction,createAlchemyProvider}=require('./blockchain-alchemy-provider.cjs');
const {classifyIntermediatePumpSell}=require('./blockchain-pump-swap-decoder.cjs');
const {reconcileTradeEvidence}=require('./blockchain-trade-reconciliation.cjs');
const raw=require('./fixtures/alchemy-three-mbc-sells.json'),mint='5dBB7trtJaHKrRhnDzPrbmZny3QJNeEGVMaBSBa8pump';
const api=createAlchemyProvider({endpoint:'https://offline',fetch(){throw Error('No network')}}),events=raw.map(normalizeFullTransaction),before=JSON.stringify(events);
for(const [i,pool] of ['3KyxhvZEixNJSMSEouKNRj7RXrUF2FigRVT4K6yJKUt9','JFNhn9HQRWkwBwa5krmUiycUdB5Rv6b3dRxkR151jzd'].entries()){
 assert.equal(api.txsToTrades([events[i]],mint).length,0,'intermediate pool inventories must not create wallet sells');
 const c=classifyIntermediatePumpSell(events[i],mint);assert.equal(c.classification,'intermediate_pool_leg');assert.equal(c.sourcePool,pool);assert.equal(c.initiator,'HbPR3bpDR8WxsqgBu6QUAZcEXhUJrdChvBt7UWyz8M82');assert.equal(c.walletTrade,false);assert.equal(c.poolPdaVerified,true);
 const damaged=structuredClone(events[i]);damaged.raw.meta.innerInstructions.forEach(g=>g.instructions=g.instructions.filter(ix=>ix.parsed?.info?.mint!==c.soldInputMint));assert.equal(classifyIntermediatePumpSell(damaged,mint),null);
 const forgedPool=structuredClone(events[i]);
 for(const d of forgedPool.tokenBalanceDeltas)if(d.owner===pool)d.owner='11111111111111111111111111111111';
 for(const b of [...forgedPool.raw.meta.preTokenBalances,...forgedPool.raw.meta.postTokenBalances])if(b.owner===pool)b.owner='11111111111111111111111111111111';
 forgedPool.raw.meta.innerInstructions.forEach(g=>g.instructions.forEach(ix=>{if(ix.parsed?.info?.authority===pool)ix.parsed.info.authority='11111111111111111111111111111111'}));
 assert.equal(classifyIntermediatePumpSell(forgedPool,mint),null,'a matching ledger without the canonical bonding-curve PDA is insufficient');
 const noSigner=structuredClone(events[i]);noSigner.raw.transaction.message.accountKeys.forEach(k=>k.signer=false);assert.equal(classifyIntermediatePumpSell(noSigner,mint),null);
}
const event=events[2],decode=e=>api.txsToTrades([e],mint),[trade]=decode(event);
assert.ok(trade);assert.equal(trade.trader,'VArQ2KwjBbMcrFXJ1MxqnwWEifJmW9veRMyw3JLwnUZ');assert.equal(trade.custodyOwner,'2L8UZgsBbhpW1ZenmY89wLGZc8UpcDzZCpneNXi3vYaQ');assert.equal(trade.executedBy,'64fcNUtAAockLpMJZ1DudHCMHJhLRBmgrmGvbrwmQzQw');
assert.equal(trade.type,'sell');assert.equal(trade.amountTokens,8916909.180178);assert.equal(trade.quoteAmount,98.809715);assert.equal(trade.quoteMint,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');assert.equal(trade.quoteAmountRaw,'98809715');assert.equal(trade.settlementGrossRaw,'99817875');assert.equal(trade.settlementDeductions[0].amountRaw,'1008160');assert.equal(trade.amountSol,0);assert.equal(trade.priceSol,0);
const r=reconcileTradeEvidence({events,trades:[trade],mint});assert.equal(r.status,'observed_matches_no_detected_mismatch');assert.equal(r.intermediatePoolLegs.length,2);assert.equal(r.eventsWithMintDeltaNoTrade.length,0);assert.equal(r.custodialAttributions.length,1);
const instructions=e=>e.raw.meta.innerInstructions.find(g=>g.index===1).instructions;
for(const mutate of [
 e=>{e.transactionError={failed:true};e.raw.meta.err={failed:true}},
 e=>{e.raw.transaction.message.instructions[1].data='unknown'},
 e=>{e.raw.transaction.message.instructions[1].programId='unknown'},
 e=>{e.raw.transaction.message.instructions[1].accounts[1]=trade.executedBy},
 e=>{e.raw.transaction.message.accountKeys.forEach(k=>k.signer=false)},
 e=>{instructions(e).find(ix=>ix.parsed?.info?.source==='3zHbWuTcDQ8FGhE3HraPwzFkeX6oizEshizqDM6T4qaQ').parsed.info.authority=trade.executedBy},
 e=>{instructions(e).find(ix=>ix.parsed?.info?.destination==='Fok6CULq6Js11qYWvCpjQKac6RwtDovHgTyXuHiY5Sxg').parsed.info.tokenAmount.amount='1'},
 e=>{instructions(e).find(ix=>ix.parsed?.type==='transfer'&&ix.parsed.info.amount==='1008160').parsed.info.amount='1'},
 e=>{e.tokenBalanceDeltas.find(d=>d.owner===trade.trader&&d.mint===trade.quoteMint).deltaRaw='1'},
]){const e=structuredClone(event);mutate(e);assert.equal(decode(e).length,0)}
for(const forged of [{...trade,trader:trade.executedBy},{...trade,quoteAmount:99.817875},{...trade,custodyOwner:'unproved'},{...trade,amountTokens:1},{...trade,amountSol:1},{...trade,priceSol:1}])assert.equal(reconcileTradeEvidence({events:[event],trades:[forged],mint}).status,'needs_review','attribution labels alone cannot bypass raw custody proof');
assert.equal(JSON.stringify(events),before,'retain immutable source evidence');
console.log('[three MBC sells] OK: two intermediate pool legs excluded; pinned limit-order beneficiary, custody, executor fee and exact net USDC independently proven; negative/forged reconciliation cases');
