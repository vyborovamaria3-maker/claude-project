"use strict";
const assert=require('node:assert/strict');
const {normalizeFullTransaction,createAlchemyProvider}=require('./blockchain-alchemy-provider.cjs');
const {pumpEvents}=require('./blockchain-pump-swap-decoder.cjs');
const {reconcileTradeEvidence}=require('./blockchain-trade-reconciliation.cjs');
const {initDb,claimOne,processOne}=require('./blockchain-seed-collector.cjs');
const {cacheWalletTrades}=require('./blockchain-wallet-cache.cjs');
const D=require('better-sqlite3');
const fixtures=require('./fixtures/alchemy-saved-swaps.json');
const mint='DWvZqqQKR2GejFVoc2Vcywg2GKLkdTqpCzWhZ2sKpump';
const p=createAlchemyProvider({endpoint:'https://solana-mainnet.g.alchemy.com/v2/offline',fetch:()=>{throw Error('Network forbidden')}});
const events=fixtures.map(normalizeFullTransaction),trades=p.txsToTrades(events,mint);
assert.equal(trades.length,10);assert.equal(trades.filter(t=>t.type==='buy').length,5);assert.equal(trades.filter(t=>t.type==='sell').length,5);
for(const trade of trades){
 const event=events.find(e=>e.signature===trade.signature),signers=event.raw.transaction.message.accountKeys.filter(k=>k.signer).map(k=>k.pubkey);
 assert.ok(signers.includes(trade.trader));
 const delta=event.tokenBalanceDeltas.find(d=>d.mint===mint&&d.owner===trade.trader);
 assert.equal(trade.type,BigInt(delta.deltaRaw)>0n?'buy':'sell');
 assert.equal(trade.amountTokens,Math.abs(delta.delta));
 assert.notEqual(trade.trader,'7k8V8sYavhxhPHg7YNjvYtSRXsf6M1Ttxj5XcDwPzpUP');
}
const routed=trades.find(t=>t.signature.startsWith('127nj1UJN'));
assert.equal(routed.trader,'6Tewbkz7JmM54ceECMmwGPZLM3htRxeYBgw9kCtFPS7v');assert.equal(routed.amountSol,0.049135801);assert.equal(routed.amountTokens,259409.450281);
const usdc=trades.find(t=>t.signature.startsWith('1TVFzkFda'));
assert.equal(usdc.quoteMint,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');assert.equal(usdc.quoteAmount,25.421658);assert.equal(usdc.amountSol,0);assert.equal(usdc.priceSol,0);
assert.equal(reconcileTradeEvidence({events,trades,mint}).status,'observed_matches_no_detected_mismatch');
const base=events.find(e=>e.signature===routed.signature);
for(const mutate of [
 e=>e.transactionError={failed:true},
 e=>e.raw.meta.err={failed:true},
 e=>e.transactionError=undefined,
 e=>e.raw.transaction.signatures[0]='wrong',
 e=>e.raw.meta.logMessages=[],
 e=>e.raw.meta.logMessages=e.raw.meta.logMessages.map(l=>l.startsWith('Program data: ')?'Program log: '+l:l),
 e=>e.raw.meta.logMessages=e.raw.meta.logMessages.map(l=>l.startsWith('Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P ')?l.replace('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P','FakeProgram'):l),
 e=>e.raw.meta.logMessages=e.raw.meta.logMessages.flatMap(l=>l.startsWith('Program data: ')?[l,l]:[l]),
 e=>e.raw.transaction.message.accountKeys.forEach(k=>k.signer=false),
 e=>e.tokenBalanceDeltas.find(d=>d.owner===routed.trader&&d.mint===mint).deltaRaw='1',
 e=>e.tokenBalanceDeltas.push({...e.tokenBalanceDeltas.find(d=>d.owner===routed.trader&&d.mint===mint),owner:'ambiguous'}),
 e=>e.raw.meta.innerInstructions=[],
 e=>{for(const g of e.raw.meta.innerInstructions)for(const ix of g.instructions)if(ix.parsed?.type==='transferChecked'&&ix.parsed.info.mint===mint)ix.parsed.info.tokenAmount.amount='1';},
]){
 const e=structuredClone(base);mutate(e);assert.equal(p.txsToTrades([e],mint).length,0);
}
const usdcEvent=structuredClone(events.find(e=>e.signature===usdc.signature));
for(const group of usdcEvent.raw.meta.innerInstructions) group.instructions=group.instructions.filter(ix=>!(ix.parsed?.type==='transfer'&&ix.parsed.info.amount==='25421658'));
assert.equal(p.txsToTrades([usdcEvent],mint).length,0,'unrelated quote delta without same-route transfer is not settlement');
const truncated=structuredClone(base);truncated.raw.meta.logMessages=truncated.raw.meta.logMessages.map(l=>l.startsWith('Program data: ')?'Program data: '+Buffer.from('bddb7fd34ee661ee','hex').toString('base64'):l);assert.equal(pumpEvents(truncated.raw).length,0);
(async()=>{
 const db=new D(':memory:');try{
 initDb(db);db.exec('CREATE TABLE token_trades(mint TEXT,signature TEXT,trader TEXT,type TEXT,amount_tokens REAL,amount_sol REAL,PRIMARY KEY(mint,signature))');
 db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES('token',?,1,100)").run(mint);
 const api={...p,fetchTransactionsForAddress:async()=>({transactions:events,exhausted:true,httpRequests:0,pagesFetched:1}),persistTokenTrades:(m,rows)=>{for(const t of rows)db.prepare('INSERT OR REPLACE INTO token_trades VALUES(?,?,?,?,?,?)').run(m,t.signature,t.trader,t.type,t.amountTokens,t.amountSol)},markTokenTradeChecked:()=>{}};
 const result=await processOne(db,claimOne(db),{recentLimit:10,backfillLimit:10},api);assert.equal(result.normalizedTrades,10);
 assert.equal(db.prepare('SELECT count(*) n FROM token_trades').get().n,10);
 const saved=db.prepare('SELECT trader FROM token_trades WHERE signature=?').get(routed.signature);assert.equal(saved.trader,routed.trader);
 cacheWalletTrades(db,routed.trader,events,p.txsToTrades,{sourceProvider:'alchemy'});
 assert.equal(db.prepare('SELECT count(*) n FROM chain_wallet_trades WHERE wallet=? AND signature=?').get(routed.trader,routed.signature).n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM chain_wallet_trades WHERE wallet=?').get(routed.protocolTrader).n,0);
 }finally{db.close()}
 console.log('[blockchain-pump-swap] OK: 10 saved real swaps (5 BUY/5 SELL), routed recipient, USDC settlement, ambiguous/failed/spoofed rejection, collector and wallet-cache persistence');
})().catch(e=>{console.error(e);process.exitCode=1});
