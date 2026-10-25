"use strict";
const assert=require('node:assert/strict');
const {normalizeFullTransaction,createAlchemyProvider}=require('./blockchain-alchemy-provider.cjs');
const {reconcileTradeEvidence}=require('./blockchain-trade-reconciliation.cjs');
const fixtures=require('./fixtures/alchemy-mbc-remaining.json');
const mint='5dBB7trtJaHKrRhnDzPrbmZny3QJNeEGVMaBSBa8pump',WXMR='WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp';
const api=createAlchemyProvider({endpoint:'https://offline',fetch(){throw Error('Network forbidden')}});
const events=fixtures.map(f=>normalizeFullTransaction(f.raw)),before=JSON.stringify(events);
const decode=e=>api.txsToTrades([e],mint),get=prefix=>events.find(e=>e.signature.startsWith(prefix));
for(const [i,e] of events.entries()){
 const trades=decode(e);assert.equal(trades.length,1);
 for(const [k,v] of Object.entries(fixtures[i].expected))assert.deepEqual(trades[0][k],v,k);
 assert.equal(reconcileTradeEvidence({events:[e],trades,mint}).status,'observed_matches_no_detected_mismatch');
 const failed=structuredClone(e);failed.transactionError={failed:true};assert.equal(decode(failed).length,0);
 const unproved=structuredClone(e);unproved.raw.meta.innerInstructions.forEach(g=>g.instructions=g.instructions.filter(ix=>ix.parsed?.info?.mint!==mint));assert.equal(decode(unproved).length,0);
 const badLedger=structuredClone(e),d=badLedger.tokenBalanceDeltas.find(d=>d.owner===(trades[0].fundedBy||trades[0].trader)&&d.mint===WXMR);
 if(d){d.deltaRaw=String(BigInt(d.deltaRaw)+1n);assert.equal(decode(badLedger).length,0)}
}
assert.equal(JSON.stringify(events),before);
assert.equal(decode(get('122ApZjt'))[0].quoteAmount,1.78,'one route group must not be counted twice');
assert.equal(decode(get('122ApZjt'))[0].trader,'97FNES6noZTDrqmEwjeKwkQE1hLpz9JbmuEaF23uPFSh');
assert.equal(decode(get('4EpiA7ad'))[0].tokenDeductions.length,2);
assert.equal(decode(get('wLuDW8j'))[0].quoteMint,WXMR,'partial SOL conversion cannot price the whole target trade');
assert.equal(decode(get('wLuDW8j'))[0].quoteAmount,0.075181962734);
assert.equal(decode(get('2YaEBBgv'))[0].quoteAmount,0.035370822,'use SPL debit, not native wrap deposit');
assert.equal(decode(get('2tSg8Bq'))[0].quoteAmount,0.135006,'route receipt is distinct from negative net wallet delta');
assert.equal(decode(get('5GNaFsWp'))[0].quoteAmount,0.165710428381,'forwarded quote remains proven WXMR, not guessed SOL');
for(const [prefix,mutate] of [
 ['4ppszLJE',e=>e.raw.meta.innerInstructions.forEach(g=>g.instructions=g.instructions.filter(ix=>ix.parsed?.type!=='mintTo'))],
 ['4EpiA7ad',e=>{const g=e.raw.meta.innerInstructions.find(g=>g.index===9);g.instructions=g.instructions.filter(ix=>ix.parsed?.info?.destination!=='AWkpEWm5R8iHrUZQbjrgb7QUqFDExEfCAtuStBnKYVJp')}],
 ['122ApZjt',e=>{const ix=e.raw.meta.innerInstructions.flatMap(g=>g.instructions).find(ix=>ix.parsed?.info?.destination==='CCfvbhsXrZ6SXBJeFuHM1FdFau7BQXs1CwUZcf5E3A8t');ix.parsed.info.authority='unknown'}],
 ['2YaEBBgv',e=>{e.raw.transaction.message.instructions=e.raw.transaction.message.instructions.map(ix=>ix.parsed?.type==='syncNative'?{...ix,parsed:{type:'unknown',info:{}}}:ix)}],
 ['122ApZjt',e=>{e.raw.meta.innerInstructions.forEach(g=>g.instructions.forEach(ix=>{if(ix.programId==='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')ix.programId='unknown'}))}],
 ['2dkVaCrp',e=>{e.raw.meta.innerInstructions=e.raw.meta.innerInstructions.filter(g=>g.index!==6)}],
]){const e=structuredClone(get(prefix));mutate(e);assert.equal(decode(e).length,0,prefix)}
console.log('[MBC remaining] OK: 12 retained transactions, creation, split/forwarded recipients, outer-group conversion, residuals, external transfers, syncNative, immutable evidence and negative proofs');
