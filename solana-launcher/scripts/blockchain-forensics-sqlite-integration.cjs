#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { gzipSync } = require("node:zlib");
const { rebuildWallet } = require("./blockchain-forensics.cjs");
const wallet = "fixture-wallet", other = "fixture-other", mint = "fixture-mint";
const db = new Database(":memory:");
try {
  db.exec([
    "CREATE TABLE chain_seed_targets(kind TEXT,address TEXT,source_mask INTEGER,priority INTEGER,backfill_complete INTEGER,",
    "possible_gap INTEGER,forward_cursor TEXT,last_success_at INTEGER,last_error TEXT,PRIMARY KEY(kind,address));",
    "CREATE TABLE chain_seed_events(kind TEXT,address TEXT,signature TEXT,observed_at INTEGER,payload_gzip BLOB,",
    "PRIMARY KEY(kind,address,signature));"
  ].join(""));
  db.prepare("INSERT INTO chain_seed_targets VALUES('wallet',?,4,90,1,0,NULL,123,NULL)").run(wallet);
  const put = db.prepare("INSERT INTO chain_seed_events VALUES('wallet',?,?,?,?)");
  const leg = (quantity) => ({ userAccount: wallet, mint,
    rawTokenAmount: { tokenAmount: String(quantity * 1e6), decimals: 6 } });
  function record(signature,slot,event) {
    const tx = { signature, slot, timestamp: slot * 10, feePayer: wallet,
      fee: 5000, type: "SWAP", events: { swap: event } };
    put.run(wallet, signature, slot, gzipSync(Buffer.from(JSON.stringify(tx))));
  }
  record("buy-sig",1,{ nativeInput: { account: wallet, amount: "1000000000" }, tokenOutputs:[leg(5)] });
  record("sell-sig",2,{ nativeOutput: { account: wallet, amount: "2000000000" }, tokenInputs:[leg(5)] });
  let result = rebuildWallet(db,wallet);
  assert.equal(result.transactions,2);
  assert.equal(result.verifiedTokens,1);
  let pnl=db.prepare("SELECT * FROM chain_forensic_wallet_pnl WHERE wallet=? AND mint=?").get(wallet,mint);
  assert.equal(pnl.status,"verified");
  assert(pnl.total_realized_pnl_sol > 0.99 && pnl.total_realized_pnl_sol < 1.01);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_activities").get().n,2);
  assert.equal(rebuildWallet(db,wallet).skipped,true,"no event changes -> no duplicate rebuild");
  const transfer = { signature:"transfer-sig",slot:3,timestamp:30,type:"TRANSFER",
    tokenTransfers:[{ fromUserAccount:other,toUserAccount:wallet,mint,tokenAmount:3 }] };
  put.run(wallet,"transfer-sig",3,gzipSync(Buffer.from(JSON.stringify(transfer))));
  record("sell-after-transfer",4,{nativeOutput:{account:wallet,amount:"1000000000"},tokenInputs:[leg(3)]});
  result=rebuildWallet(db,wallet);
  assert.equal(result.unknownTokens,1);
  pnl=db.prepare("SELECT * FROM chain_forensic_wallet_pnl WHERE wallet=? AND mint=?").get(wallet,mint);
  assert.equal(pnl.total_realized_pnl_sol,null);
  assert.notEqual(pnl.known_realized_pnl_sol,null,"prior matched trades can be labeled as partial PnL");
  assert(JSON.parse(pnl.unknown_reasons).includes("sale_without_verified_cost_basis"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_edges WHERE to_wallet=? AND from_wallet=?").get(wallet,other).n,1);
  db.prepare("UPDATE chain_seed_targets SET possible_gap=1 WHERE address=?").run(wallet);
  rebuildWallet(db,wallet);
  pnl=db.prepare("SELECT * FROM chain_forensic_wallet_pnl WHERE wallet=? AND mint=?").get(wallet,mint);
  assert.equal(pnl.coverage_complete,0);
  assert.equal(pnl.total_realized_pnl_sol,null);
  const current=db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_activities").get().n;
  put.run(wallet,"bad-cache",5,Buffer.from("not-gzip"));
  assert.throws(()=>rebuildWallet(db,wallet),/Invalid cached transaction/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_forensic_activities").get().n,current,
    "invalid raw cache must never partially replace materialized evidence");
  console.log("[blockchain-forensics-sqlite-integration] OK: cached replay, exact signatures, persistence, edges, unknown basis, gaps, atomic rebuild");
} finally { db.close(); }
