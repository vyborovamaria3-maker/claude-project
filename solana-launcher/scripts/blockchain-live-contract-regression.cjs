"use strict";
const assert=require('node:assert/strict'),D=require('better-sqlite3');
const {createAlchemyProvider,normalizeFullTransaction}=require('./blockchain-alchemy-provider.cjs');
const {decodeInventoryMovements}=require('./blockchain-inventory-decoder.cjs');
const {initDb,claimOne,processOne}=require('./blockchain-seed-collector.cjs');
const pages=require('./fixtures/alchemy-audit-pages.json');
const routed=require('./fixtures/routed-buy-attribution.json');
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function provider(reply){return createAlchemyProvider({endpoint:'https://solana-mainnet.g.alchemy.com/v2/offline',sleep:async()=>{},fetch:async(_u,o)=>{const q=JSON.parse(o.body);assert.equal(q.params[1].maxSupportedTransactionVersion,0);return {ok:true,status:200,json:async()=>({result:reply(q)})}}});}
(async()=>{
 let calls=0;const p=provider(()=>pages[calls++]);const db=new D(':memory:');
 try{
  initDb(db);const api={...p,persistTokenTrades:()=>{},markTokenTradeChecked:()=>{}};
  for(const [kind,address] of [['token','DWvZqqQKR2GejFVoc2Vcywg2GKLkdTqpCzWhZ2sKpump'],['wallet','6Tewbkz7JmM54ceECMmwGPZLM3htRxeYBgw9kCtFPS7v']]){
   db.prepare('INSERT INTO chain_seed_targets(kind,address,source_mask,priority) VALUES(?,?,1,100)').run(kind,address);
   for(let i=0;i<2;i++){
    db.prepare('UPDATE chain_seed_targets SET next_run_at=0,source_mask=CASE WHEN kind=? THEN 1 ELSE 0 END').run(kind);
    const row=claimOne(db);await processOne(db,row,{recentLimit:1,backfillLimit:1},api);
   }
  }
  assert.equal(calls,6);assert.equal(db.prepare('SELECT count(*) n FROM chain_seed_events').get().n,4);
  assert.equal(db.prepare("SELECT count(*) n FROM chain_seed_targets WHERE backfill_complete=1").get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM chain_inventory_movements WHERE amount_raw IS NULL").get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM chain_wallet_discovery WHERE history_status='complete'").get().n,0);
 }finally{db.close()}
 const live=normalizeFullTransaction(routed.event.raw),movements=decodeInventoryMovements(live);
 assert.ok(movements.length>0);assert.ok(movements.every(m=>m.amountRaw!==null));
 assert.deepEqual(decodeInventoryMovements({...live,transactionError:{failed:true}}),[]);
 assert.deepEqual(decodeInventoryMovements({...live,transactionError:undefined}),[]);
 assert.deepEqual(decodeInventoryMovements({...live,decodedOperations:[{programId:'11111111111111111111111111111111',type:'transfer',info:{source:'a',destination:'b',lamports:10}}]}),[]);
 // Two accounts owned by one wallet must retain their individual metadata.
 const multi={signature:'multi',transactionError:null,accountKeys:['a','b'],preTokenBalances:[0,1].map(accountIndex=>({accountIndex,owner:'owner',mint:'mint',uiTokenAmount:{decimals:6}})),postTokenBalances:[],tokenBalanceDeltas:[{tokenAccount:'a',owner:'owner',mint:'mint',decimals:6}],decodedOperations:[{programId:TOKEN,type:'transfer',info:{source:'b',destination:'a',amount:'1'}}]};
 assert.ok(decodeInventoryMovements(multi).every(m=>m.owner==='owner'&&m.mint==='mint'&&m.decimals===6));
 const feeProvider=provider(()=>({data:[]}));
 const feeTx={signature:'fee',transactionError:null,instructionProgramIds:['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],accountKeys:['fee-payer','buyer'],preBalances:[10000,2000000],postBalances:[5000,1000000],meta:{fee:5000},tokenBalanceDeltas:[{mint:'mint',owner:'buyer',deltaRaw:'10',delta:10}]};
 assert.equal(feeProvider.txsToTrades([feeTx],'mint')[0].amountSol,0.001, 'fees belong only to first account, not every owner');
 assert.deepEqual(feeProvider.txsToTrades([{...feeTx,transactionError:undefined}],'mint'),[]);
 assert.ok(decodeInventoryMovements(routed.event).length>0, 'previously stored SPL program labels remain compatible');
 const unknown=normalizeFullTransaction({slot:null,blockTime:null,transaction:{signatures:['unknown'],message:{}},meta:{}});
 assert.equal(unknown.slot,null);assert.equal(unknown.timestamp,null);assert.notEqual(unknown.transactionError,null);
 await assert.rejects(provider(()=>({data:[pages[0].data[0]],paginationToken:'same'})).fetchTransactionsForAddress('address',1,new Set(),'alchemy:v1:same'),/did not advance/);
 await assert.rejects(provider(()=>({data:[{}],paginationToken:'next'})).fetchTransactionsForAddress('address',1),/missing signature/);
 console.log('[blockchain-live-contract] OK: six real Alchemy pages replayed offline, token/wallet persistence, cursors, native/failed exclusion, account metadata and unknown execution');
})().catch(e=>{console.error(e);process.exitCode=1});
