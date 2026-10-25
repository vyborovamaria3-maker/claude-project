"use strict";
const assert = require('node:assert/strict');
const {normalizeFullTransaction,createAlchemyProvider} = require('./blockchain-alchemy-provider.cjs');
const {reconcileTradeEvidence} = require('./blockchain-trade-reconciliation.cjs');
const fixtures = require('./fixtures/alchemy-wxmr-swaps.json');
const mint = '5dBB7trtJaHKrRhnDzPrbmZny3QJNeEGVMaBSBa8pump';
const WXMR = 'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp';
const api = createAlchemyProvider({endpoint:'https://offline',fetch(){throw Error('Network forbidden')}});
const events = fixtures.map(f=>normalizeFullTransaction(f.raw)), before=JSON.stringify(events);
for (const [i,event] of events.entries()) {
  const trades=api.txsToTrades([event],mint); assert.equal(trades.length,1);
  const t=trades[0]; for(const [k,v] of Object.entries(fixtures[i].expected)) assert.equal(t[k],v,k);
  assert.ok(t.quoteAmount>0); assert.equal(t.protocolAmountSol,undefined);
  assert.equal(t.settlementEvidence,'wxmr_pool_and_wallet_transfer_ledger');
  if(t.quoteMint!== 'So11111111111111111111111111111111111111112') {assert.equal(t.amountSol,0);assert.equal(t.priceSol,0)}
  assert.equal(reconcileTradeEvidence({events:[event],trades,mint}).status,'observed_matches_no_detected_mismatch');
}
assert.equal(JSON.stringify(events),before);
const direct=events.find(e=>e.signature.startsWith('26YEwKx2'));
const buy=api.txsToTrades([direct],mint)[0];assert.equal(buy.quoteAmount,0.039019277351);assert.equal(buy.amountTokens,3979272.58205);
for(const mutate of [
 e=>{e.transactionError={failed:true};e.raw.meta.err={failed:true}},
 e=>e.raw.transaction.message.accountKeys.forEach(k=>k.signer=false),
 e=>{e.raw.meta.innerInstructions.forEach(g=>g.instructions=g.instructions.filter(ix=>ix.parsed?.info?.mint!==WXMR))},
 e=>{e.raw.meta.innerInstructions.forEach(g=>g.instructions=g.instructions.filter(ix=>ix.parsed?.info?.mint!==mint))},
 e=>{e.tokenBalanceDeltas.find(d=>d.owner===buy.trader&&d.mint===WXMR).deltaRaw='-1'},
 e=>{e.raw.meta.logMessages=[]},
]) {const e=structuredClone(direct);mutate(e);assert.equal(api.txsToTrades([e],mint).length,0)}
const native=events.find(e=>api.txsToTrades([e],mint)[0].quoteMint==='So11111111111111111111111111111111111111112');
const missingInit=structuredClone(native);
missingInit.raw.meta.innerInstructions.forEach(g=>g.instructions=g.instructions.filter(ix=>!['initializeAccount','initializeAccount2','initializeAccount3'].includes(ix.parsed?.type)));
assert.equal(api.txsToTrades([missingInit],mint).length,0,'unowned temporary SOL account must not produce a price');
console.log('[wxmr] OK: 8 retained swaps, v0/v1/legacy, SOL/USDC/WXMR settlement, immutable evidence and negative proof cases');


const {summarizeQuotes,rebuildQuoteSummary,markSolPnlUnavailable}=require('./blockchain-quote-summary.cjs');
const Database=require('better-sqlite3'),db=new Database(':memory:');
const decoded=events.flatMap(e=>api.txsToTrades([e],mint));
const summaries=rebuildQuoteSummary(db,mint,decoded);
assert.ok(summaries.every(r=>r.realizedPnl===null));
assert.equal(summaries.reduce((n,r)=>n+r.buys+r.sells,0),8);
assert.equal(db.prepare('SELECT SUM(buys+sells) n FROM chain_trade_quote_summary').get().n,8);
rebuildQuoteSummary(db,mint,decoded);assert.equal(db.prepare('SELECT SUM(buys+sells) n FROM chain_trade_quote_summary').get().n,8);
const sameWallet=decoded.map(t=>({...t,trader:'same-wallet'}));
assert.equal(summarizeQuotes(sameWallet).length,3,'SOL, USDC and WXMR totals stay separate');
assert.throws(()=>summarizeQuotes([{...decoded[0],quoteAmountRaw:'0'}]));
assert.throws(()=>summarizeQuotes([decoded[0],{...decoded[0],quoteDecimals:18}]));
db.exec("CREATE TABLE wallet_token_stats(address TEXT,mint TEXT,pnl_sol REAL NOT NULL);CREATE TABLE wallet_stats(address TEXT,total_pnl_sol REAL NOT NULL);INSERT INTO wallet_token_stats VALUES('a','MBC',0),('a','old',5);INSERT INTO wallet_stats VALUES('a',5)");
markSolPnlUnavailable(db,'MBC',['a']);markSolPnlUnavailable(db,'MBC',['a']);
assert.equal(db.prepare("SELECT pnl_status FROM wallet_token_stats WHERE mint='MBC'").get().pnl_status,'unavailable_incomplete_inventory');
assert.equal(db.prepare("SELECT pnl_status FROM wallet_token_stats WHERE mint='old'").get().pnl_status,'legacy_diagnostic');
assert.equal(db.prepare('SELECT total_pnl_sol FROM wallet_stats').get().total_pnl_sol,5);
db.close();
console.log('[wxmr-cache] OK: exact per-quote totals, no fabricated PnL, idempotent SQLite refresh');
