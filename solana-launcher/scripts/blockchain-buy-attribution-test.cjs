"use strict";
const assert=require('node:assert/strict');
const {gzipSync}=require('node:zlib');
const D=require('better-sqlite3');
const fixture=require('./fixtures/routed-buy-attribution.json');
const {normalizeFullTransaction}=require('./blockchain-alchemy-provider.cjs');
const {resolveRoutedBuy,repair}=require('./blockchain-buy-attribution.cjs');
const {reconcileTradeEvidence}=require('./blockchain-trade-reconciliation.cjs');
const event=normalizeFullTransaction(fixture.event.raw), trade=fixture.trade;
const proof=resolveRoutedBuy(trade,event);
assert.equal(proof.status,'confirmed_routed_buyer');
assert.equal(proof.trader,'6Tewbkz7JmM54ceECMmwGPZLM3htRxeYBgw9kCtFPS7v');
assert.equal(reconcileTradeEvidence({events:[event],trades:[trade],mint:trade.mint}).directionMismatches.length,1);
assert.equal(reconcileTradeEvidence({events:[event],trades:[{...trade,trader:proof.trader}],mint:trade.mint}).status,'observed_matches_no_detected_mismatch');
for(const mutate of [
 e=>e.transactionError={failed:true},
 e=>e.raw.meta.err={failed:true},
 e=>e.signature='other',
 e=>e.raw.transaction.message.accountKeys[0].signer=false,
 e=>e.postBalances[0]=e.preBalances[0],
 e=>e.tokenBalanceDeltas.push({...e.tokenBalanceDeltas.find(d=>d.owner===proof.trader),owner:'other'}),
 e=>e.raw.meta.innerInstructions=[],
 e=>{for(const g of e.raw.meta.innerInstructions) for(const ix of g.instructions)if(ix.parsed?.type==='transferChecked')ix.parsed.info.tokenAmount.amount='1';},
]) {
 const e=structuredClone(event);mutate(e);assert.equal(resolveRoutedBuy(trade,e).status,'unresolved');
}
assert.equal(resolveRoutedBuy({...trade,amount_tokens:1},event).status,'unresolved');
assert.equal(resolveRoutedBuy({...trade,source:'unknown'},event).status,'unresolved');
const db=new D(':memory:');
try {
 db.exec('CREATE TABLE token_trades(mint TEXT,signature TEXT,trader TEXT,type TEXT,amount_tokens REAL,amount_sol REAL,source TEXT); CREATE TABLE chain_seed_events(kind TEXT,address TEXT,signature TEXT,payload_gzip BLOB)');
 db.prepare('INSERT INTO token_trades VALUES(?,?,?,?,?,?,?)').run(trade.mint,trade.signature,trade.trader,trade.type,trade.amount_tokens,trade.amount_sol,trade.source);
 db.prepare('INSERT INTO chain_seed_events VALUES(?,?,?,?)').run('token',trade.mint,trade.signature,gzipSync(JSON.stringify(event)));
 db.exec("CREATE TRIGGER stop_repair BEFORE UPDATE ON token_trades BEGIN SELECT RAISE(ABORT,'rollback test'); END");
 assert.throws(()=>repair(db,trade.mint,trade.signature),/rollback test/);
 assert.equal(db.prepare('SELECT trader FROM token_trades').get().trader,trade.trader);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='chain_trade_attribution_repairs'").get().n,0);
 db.exec('DROP TRIGGER stop_repair');
 repair(db,trade.mint,trade.signature);
 assert.equal(db.prepare('SELECT trader FROM token_trades').get().trader,proof.trader);
 assert.equal(JSON.parse(db.prepare('SELECT previous_row_json FROM chain_trade_attribution_repairs').get().previous_row_json).trader,trade.trader);
 assert.throws(()=>repair(db,trade.mint,trade.signature));
 assert.equal(db.prepare('SELECT count(*) n FROM chain_trade_attribution_repairs').get().n,1);
}finally{db.close();}
console.log('[blockchain-buy-attribution] OK: real routed BUY, conservative rejection, audited atomic repair and rollback');
