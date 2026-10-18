#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const {gzipSync}=require("node:zlib");
const {initDb}=require("./blockchain-seed-collector.cjs");
const {initForensics,rebuildWallet}=require("./blockchain-forensics.cjs");
const db=new Database(":memory:");
const wallet="1".repeat(32), mint="2".repeat(44);
const COUNT=1500;
try {
  initDb(db);initForensics(db);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority,backfill_complete,last_success_at) VALUES('wallet',?,4,90,1,123)").run(wallet);
  const insert=db.prepare("INSERT INTO chain_seed_events(kind,address,signature,block_time,slot,payload_gzip,payload_bytes,observed_at,raw_revision) VALUES('wallet',?,?,?,?,?,?,?,1)");
  db.transaction(()=>{
    for(let i=0;i<COUNT*2;i++) {
      const buy=i%2===0,signature="load-"+String(i).padStart(7,"0");
      const rawAmount={tokenAmount:"1000000",decimals:6};
      const swap=buy?{nativeInput:{account:wallet,amount:"1000000000"},
        tokenOutputs:[{userAccount:wallet,mint,rawTokenAmount:rawAmount}]}:
        {nativeOutput:{account:wallet,amount:"2000000000"},
          tokenInputs:[{userAccount:wallet,mint,rawTokenAmount:rawAmount}]};
      const tx={signature,type:"SWAP",slot:111500000+i,timestamp:1700000000+i,
        feePayer:wallet,fee:5000,events:{swap},accountData:[{
          account:wallet,nativeBalanceChange:(buy?-1000000000:2000000000)-5000,
          tokenBalanceChanges:[{mint,userAccount:wallet,rawTokenAmount:{
            tokenAmount:buy?"1000000":"-1000000",decimals:6}}]}]};
      const payload=JSON.stringify(tx),blob=gzipSync(Buffer.from(payload));
      insert.run(wallet,signature,tx.timestamp,tx.slot,blob,Buffer.byteLength(payload),123);
    }
  })();
  const first=rebuildWallet(db,wallet);
  assert.equal(first.newlyParsed,COUNT*2);
  assert.equal(first.pricedTrades,COUNT*2);
  assert.equal(first.verifiedTokens,1);
  assert.equal(first.coverageComplete,true);
  const pnl=db.prepare("SELECT * FROM chain_forensic_wallet_pnl WHERE wallet=? AND mint=?").get(wallet,mint);
  assert.equal(pnl.status,"verified");
  assert.equal(pnl.sells,COUNT);
  assert(Math.abs(pnl.total_realized_pnl_sol-(COUNT*(1-0.00001)))<0.0001);
  assert.equal(rebuildWallet(db,wallet).skipped,true);
  const plan=db.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM chain_forensic_activities WHERE wallet=? "+
    "ORDER BY mint,COALESCE(slot,block_time,0),COALESCE(block_time,0),signature,leg_index"
  ).all(wallet).map(r=>r.detail).join(" | ");
  assert.match(plan,/idx_forensic_fifo_stream/);
  assert.doesNotMatch(plan,/TEMP B-TREE/);
  console.log("[blockchain-forensics-stream-sqlite] OK: 3000 gzip transactions, batched replay, SQL FIFO index, stable verified PnL and cache hit");
}finally{db.close();}
