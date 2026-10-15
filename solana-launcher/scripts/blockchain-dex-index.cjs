#!/usr/bin/env node
"use strict";

// Opt-in, bounded local DEX-program observation index. A program scan does NOT
// assert global trade-tape completeness, common wallet ownership or FIFO PnL.
const { gunzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { parseEvidence } = require("./blockchain-forensics-core.cjs");
const { isSolanaAddress } = require("./blockchain-seed-core.cjs");
const REVISION = 2;
function configuredDexPrograms(input = process.env.CHAIN_DEX_PROGRAM_IDS || "") {
  const values = input.split(/[,\s;]+/).map(x => x.trim()).filter(Boolean);
  if (values.length > 8) throw new Error("At most eight DEX program addresses per local collection");
  const unique = [...new Set(values)];
  if (unique.some(x => !isSolanaAddress(x)))
    throw new Error("CHAIN_DEX_PROGRAM_IDS must contain valid 32-byte base58 Solana program addresses");
  return unique;
}
const dexInitialized = new WeakSet();
function initDexIndex(db) {
  if (dexInitialized.has(db)) return;
  db.exec([
    "CREATE TABLE IF NOT EXISTS chain_dex_observed_trades (",
    "program TEXT NOT NULL,signature TEXT NOT NULL,wallet TEXT NOT NULL,",
    "mint TEXT NOT NULL,side TEXT NOT NULL,slot INTEGER,block_time INTEGER,",
    "amount_tokens REAL NOT NULL,amount_sol REAL NOT NULL,fee_sol REAL,",
    "indexed_at INTEGER NOT NULL,PRIMARY KEY(program,signature,wallet,mint,side))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_dex_mint_time ON chain_dex_observed_trades(mint,block_time DESC)",
    ";CREATE INDEX IF NOT EXISTS idx_chain_dex_wallet ON chain_dex_observed_trades(wallet,mint)",
    ";CREATE INDEX IF NOT EXISTS idx_chain_dex_mint_slot ON chain_dex_observed_trades(mint,slot DESC)",
    ";CREATE TABLE IF NOT EXISTS chain_dex_indexed_signatures (",
    "program TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,",
    "payload_hash TEXT,decode_status TEXT NOT NULL DEFAULT 'unknown',",
    "PRIMARY KEY(program,signature))",
  ].join("\n"));
  const cols=db.pragma("table_info(chain_dex_indexed_signatures)").map(c=>c.name);
  if (!cols.includes("payload_hash")) db.exec("ALTER TABLE chain_dex_indexed_signatures ADD COLUMN payload_hash TEXT");
  if (!cols.includes("decode_status")) db.exec("ALTER TABLE chain_dex_indexed_signatures ADD COLUMN decode_status TEXT NOT NULL DEFAULT 'unknown'");

  // Keep materialized trades tied to the exact original Helius event.
  db.exec([
    "CREATE TRIGGER IF NOT EXISTS dex_raw_revision AFTER UPDATE OF payload_hash,raw_revision ON chain_seed_events",
    "WHEN NEW.kind='dex_program' AND (OLD.payload_hash IS NOT NEW.payload_hash OR OLD.raw_revision<>NEW.raw_revision) BEGIN",
    "DELETE FROM chain_dex_observed_trades WHERE program=NEW.address AND signature=NEW.signature;",
    "DELETE FROM chain_dex_indexed_signatures WHERE program=NEW.address AND signature=NEW.signature; END;",
    "CREATE TRIGGER IF NOT EXISTS dex_raw_delete AFTER DELETE ON chain_seed_events WHEN OLD.kind='dex_program' BEGIN",
    "DELETE FROM chain_dex_observed_trades WHERE program=OLD.address AND signature=OLD.signature;",
    "DELETE FROM chain_dex_indexed_signatures WHERE program=OLD.address AND signature=OLD.signature; END;",
  ].join("\n"));
  dexInitialized.add(db);
}
function extractDexObservations(tx, program) {
  if (!tx || !tx.signature || !tx.events?.swap || tx.transactionError != null ||
      tx.error != null) return [];
  const swap = tx.events.swap;
  const wallets = new Set();
  for (const leg of [...(swap.tokenInputs || []), ...(swap.tokenOutputs || [])]) {
    if (isSolanaAddress(leg.userAccount)) wallets.add(leg.userAccount);
  }
  for (const leg of [swap.nativeInput, swap.nativeOutput]) {
    if (isSolanaAddress(leg?.account)) wallets.add(leg.account);
  }
  const found = [];
  const seen = new Set();
  for (const wallet of wallets) {
    const events = parseEvidence(tx, wallet);
    const ambiguous = new Set(events.filter(x => x.kind === "unpriced").map(x => x.mint));
    for (const event of events) {
      if ((event.kind !== "buy" && event.kind !== "sell") ||
          ambiguous.has(event.mint) || !isSolanaAddress(event.mint) ||
          !Number.isFinite(event.amountTokens) || !(event.amountTokens > 0) ||
          !Number.isFinite(event.amountSol) || !(event.amountSol > 0)) continue;
      const key = [tx.signature, wallet, event.mint, event.kind].join(":");
      if (seen.has(key)) {
        // A duplicate leg needs explicit fill-level indexing; skip ambiguity.
        const n = found.findIndex(x => x.key === key);
        if (n >= 0) found.splice(n, 1);
        continue;
      }
      seen.add(key);
      found.push({ key, program, signature: tx.signature, wallet,
        mint: event.mint, side: event.kind, slot: event.slot,
        timestamp: event.timestamp, amountTokens: event.amountTokens,
        amountSol: event.amountSol, feeSol: event.feeSol });
    }
  }
  return found;
}
function indexProgramBatch(db, program, transactions) {
  if (!isSolanaAddress(program)) throw new Error("Invalid DEX program address");
  initDexIndex(db);
  const put = db.prepare("INSERT OR IGNORE INTO chain_dex_observed_trades(program,signature,wallet,mint,side,slot,block_time,amount_tokens,amount_sol,fee_sol,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const mark = db.prepare("INSERT INTO chain_dex_indexed_signatures(program,signature,revision,payload_hash,decode_status) VALUES(?,?,?,?,?) ON CONFLICT(program,signature) DO UPDATE SET revision=excluded.revision,payload_hash=excluded.payload_hash,decode_status=excluded.decode_status");
  const known = db.prepare("SELECT revision,payload_hash FROM chain_dex_indexed_signatures WHERE program=? AND signature=?");
  const remove = db.prepare("DELETE FROM chain_dex_observed_trades WHERE program=? AND signature=?");
  let observations = 0, transactionsIndexed = 0;
  db.transaction(() => {
    for (const tx of transactions) {
      if (!tx || typeof tx.signature !== "string" || !tx.signature) continue;
      const hash=createHash("sha256").update(JSON.stringify(tx)).digest("hex");
      const prior=known.get(program,tx.signature);
      if (prior?.revision === REVISION && prior.payload_hash === hash) continue;
      // One signature may have been replaced by a richer Helius decoded payload.
      remove.run(program,tx.signature);
      const observationsForTx=extractDexObservations(tx,program);
      for (const event of observationsForTx) {
        observations += put.run(program,tx.signature,event.wallet,event.mint,event.side,
          event.slot,event.timestamp,event.amountTokens,event.amountSol,event.feeSol,Date.now()).changes;
      }
      mark.run(program,tx.signature,REVISION,hash,observationsForTx.length ? "observed" : "unpriced_or_irrelevant");
      transactionsIndexed++;
    }
  })();
  return { program, transactionsIndexed, observations, revision: REVISION };
}
function replayProgram(db, program, limit = 10000) {
  if (!isSolanaAddress(program)) throw new Error("Invalid DEX program address");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error("Invalid replay limit");
  initDexIndex(db);
  const rows = db.prepare(
    "SELECT e.signature,e.payload_gzip FROM chain_seed_events e LEFT JOIN chain_dex_indexed_signatures p " +
    "ON p.program=e.address AND p.signature=e.signature " +
    "WHERE e.kind='dex_program' AND e.address=? AND (p.signature IS NULL OR p.revision<>? " +
    "OR (e.payload_hash IS NOT NULL AND (p.payload_hash IS NULL OR p.payload_hash<>e.payload_hash))) " +
    "ORDER BY e.block_time DESC,e.signature DESC LIMIT ?"
  ).all(program,REVISION,limit);
  const txs = rows.map(row => {
    let tx;
    try { tx=JSON.parse(gunzipSync(row.payload_gzip).toString("utf8")); }
    catch(e) { throw new Error("Invalid DEX cached transaction "+row.signature+": "+String(e)); }
    if(tx.signature !== row.signature) throw new Error("Cached DEX signature mismatch: "+row.signature);
    return tx;
  });
  return indexProgramBatch(db,program,txs);
}
module.exports = { configuredDexPrograms, initDexIndex, extractDexObservations, indexProgramBatch, replayProgram };
