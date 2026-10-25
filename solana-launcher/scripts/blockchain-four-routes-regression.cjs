"use strict";
const assert=require('node:assert/strict');
const {normalizeFullTransaction,createAlchemyProvider}=require('./blockchain-alchemy-provider.cjs');
const {reconcileTradeEvidence}=require('./blockchain-trade-reconciliation.cjs');
const raw=require('./fixtures/alchemy-four-routes.json');
const mint='DWvZqqQKR2GejFVoc2Vcywg2GKLkdTqpCzWhZ2sKpump';
const provider=createAlchemyProvider({endpoint:'https://solana-mainnet.g.alchemy.com/v2/offline',fetch:()=>{throw Error('No network')}});
const events=raw.map(normalizeFullTransaction),snapshot=JSON.stringify(events);
const trades=provider.txsToTrades(events,mint);assert.equal(trades.length,4);assert.ok(trades.every(t=>t.type==='buy'&&t.amountSol===0&&t.priceSol===0));
assert.equal(JSON.stringify(events),snapshot,'decoding must not mutate retained evidence');
const split=trades.find(t=>t.signature.startsWith('212CwfQay'));
assert.equal(split.trader,'djykmNqGFVLwHUPuurpVmRrtcCga5MbBtRd1eqCtdqJ');
assert.equal(split.fundedBy,'GLJP4p3Vqs194STJ7m4ZTnDKf2npLNnBNTtpFnUvCT9C');
assert.equal(split.amountTokens,332461.558363);assert.equal(split.grossTokenAmountRaw,'335749859921');
assert.equal(split.tokenDeductions[0].amountRaw,'3288301558');assert.equal(split.quoteAmount,7.003703);
for(const [prefix,amount,gross,extra] of [['1eo6zL3qB',32.05,'-33000000','-950000'],['26GYApka5',10.95111,'-11901110','-950000'],['21uF4XpKF',200,'-202000000','-2000000']]){
 const t=trades.find(t=>t.signature.startsWith(prefix));assert.equal(t.quoteAmount,amount);assert.equal(t.quoteWalletDeltaRaw,gross);assert.equal(t.quoteExternalDeltaRaw,extra);
}
assert.equal(reconcileTradeEvidence({events,trades,mint}).status,'observed_matches_no_detected_mismatch');
const splitEvent=events[0];
for(const mutate of [
 e=>e.transactionError={failed:true},
 e=>e.raw.transaction.message.instructions[8].data='unknown',
 e=>e.raw.transaction.message.instructions[8].programId='unknown',
 e=>e.raw.transaction.message.instructions[8].accounts[1]='unowned',
 e=>e.raw.transaction.message.instructions[8].accounts[2]='unknown',
 e=>e.raw.transaction.message.accountKeys.forEach(k=>k.signer=false),
 e=>e.tokenBalanceDeltas.find(d=>d.owner===split.trader).deltaRaw='1',
 e=>{const group=e.raw.meta.innerInstructions.find(g=>g.index===8);group.instructions.reverse();},
 e=>{const group=e.raw.meta.innerInstructions.find(g=>g.index===8);group.instructions=group.instructions.filter(ix=>ix.parsed?.info?.tokenAmount?.amount!=='3288301558');},
]){const e=structuredClone(splitEvent);mutate(e);assert.equal(provider.txsToTrades([e],mint).length,0);}
for(const original of events.slice(1)){
 const e=structuredClone(original);e.raw.meta.innerInstructions.forEach(g=>{g.instructions=g.instructions.filter(ix=>!(ix.parsed?.type==='transfer'&&['32050000','10951110','200000000'].includes(ix.parsed.info.amount)));});
 assert.equal(provider.txsToTrades([e],mint).length,0,'missing route debit must not be replaced by total wallet debit');
 const outside=structuredClone(original);outside.raw.transaction.message.instructions=outside.raw.transaction.message.instructions.filter(ix=>!['transfer','transferChecked'].includes(ix.parsed?.type));
 assert.equal(provider.txsToTrades([outside],mint).length,0,'all external debits must reconcile with observed balance');
}
console.log('[blockchain-four-routes] OK: 4 saved BUY, route/external quote ledger, funded recipient and split deductions, immutable evidence, negative cases');
