#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const {initDb,persistEvents}=require("./blockchain-seed-collector.cjs");
const db=new Database(":memory:");
try {
  db.exec([
    "CREATE TABLE chain_seed_targets(",
    "kind TEXT NOT NULL,address TEXT NOT NULL,source_mask INTEGER NOT NULL DEFAULT 0,",
    "priority INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER NOT NULL DEFAULT 0,",
    "last_success_at INTEGER,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,",
    "last_error TEXT,backfill_cursor TEXT,backfill_complete INTEGER NOT NULL DEFAULT 0,",
    "possible_gap INTEGER NOT NULL DEFAULT 0,events_saved INTEGER NOT NULL DEFAULT 0,",
    "PRIMARY KEY(kind,address))",
    ";CREATE TABLE chain_seed_events(",
    "kind TEXT NOT NULL,address TEXT NOT NULL,signature TEXT NOT NULL,",
    "block_time INTEGER,slot INTEGER,payload_gzip BLOB NOT NULL,payload_bytes INTEGER NOT NULL,",
    "observed_at INTEGER NOT NULL,PRIMARY KEY(kind,address,signature))"
  ].join(" "));
  const wallet="1".repeat(32);
  db.prepare("INSERT INTO chain_seed_targets(kind,address,source_mask,priority,backfill_complete,last_success_at) VALUES('wallet',?,4,90,1,123)").run(wallet);
  const tx={signature:"old-sig",slot:111500000,timestamp:100,fee:5000,type:"TRANSFER",tokenTransfers:[]};
  const raw=JSON.stringify(tx);
  const packed=require("node:zlib").gzipSync(Buffer.from(raw));
  db.prepare("INSERT INTO chain_seed_events(kind,address,signature,slot,block_time,payload_gzip,payload_bytes,observed_at) VALUES('wallet',?,?,?,?,?,?,?)")
    .run(wallet,"old-sig",tx.slot,tx.timestamp,packed,Buffer.byteLength(raw),123);
  initDb(db);
  for(const column of ["lease_token","wallet_history_mode","forward_cursor"])
    assert(db.pragma("table_info(chain_seed_targets)").some(c=>c.name===column));
  for(const column of ["payload_hash","raw_revision"])
    assert(db.pragma("table_info(chain_seed_events)").some(c=>c.name===column));
  assert.equal(db.prepare("SELECT backfill_complete FROM chain_seed_targets WHERE address=?").get(wallet).backfill_complete,0,
    "old wallet history must be invalidated once for token-account coverage");
  const updated={...tx,type:"UNKNOWN"};
  assert.equal(persistEvents(db,"wallet",wallet,[updated]),1);
  const after=db.prepare("SELECT raw_revision,payload_hash FROM chain_seed_events WHERE address=? AND signature=?").get(wallet,tx.signature);
  assert.equal(after.raw_revision,2);
  assert.equal(after.payload_hash.length,64);
  assert.equal(persistEvents(db,"wallet",wallet,[updated]),0);
  initDb(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events").get().n,1);
  console.log("[blockchain-legacy-schema-migration] OK: additive old SQLite upgrade, provenance, coverage reset, idempotent upsert");
}finally{db.close();}
