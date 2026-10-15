#!/usr/bin/env node
"use strict";

// Replays persisted Helius evidence. No Excel values, network calls, or guessed PnL.
const { gunzipSync } = require("node:zlib");
const path = require("node:path");
const { parseEvidence, computePnl } = require("./blockchain-forensics-core.cjs");
const REVISION = 3;

function initForensics(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS chain_forensic_activities (",
    " wallet TEXT NOT NULL, signature TEXT NOT NULL, leg_index INTEGER NOT NULL,",
    " slot INTEGER, block_time INTEGER, kind TEXT NOT NULL, mint TEXT NOT NULL,",
    " amount_tokens REAL, amount_sol REAL, fee_sol REAL, counterparty TEXT,",
    " PRIMARY KEY(wallet,signature,leg_index))",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_trades_mint",
    " ON chain_forensic_activities(mint,kind,slot)",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_activities_wallet",
    " ON chain_forensic_activities(wallet,slot)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_edges (",
    " observer_wallet TEXT NOT NULL, signature TEXT NOT NULL, leg_index INTEGER NOT NULL,",
    " mint TEXT NOT NULL, from_wallet TEXT NOT NULL, to_wallet TEXT NOT NULL,",
    " amount_tokens REAL NOT NULL,",
    " PRIMARY KEY(observer_wallet,signature,leg_index))",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_edges_from ON chain_forensic_edges(from_wallet)",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_edges_to ON chain_forensic_edges(to_wallet)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_wallet_pnl (",
    " wallet TEXT NOT NULL, mint TEXT NOT NULL, coverage_complete INTEGER NOT NULL,",
    " status TEXT NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL,",
    " transfers INTEGER NOT NULL, known_sells INTEGER NOT NULL,",
    " known_realized_pnl_sol REAL, total_realized_pnl_sol REAL,",
    " unknown_reasons TEXT NOT NULL, updated_at INTEGER NOT NULL,",
    " PRIMARY KEY(wallet,mint))",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_pnl_mint ON chain_forensic_wallet_pnl(mint)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_wallet_sync (",
    " wallet TEXT PRIMARY KEY, revision INTEGER NOT NULL, observed_count INTEGER NOT NULL,",
    " max_observed_at INTEGER NOT NULL, coverage_complete INTEGER NOT NULL,",
    " analyzed_at INTEGER NOT NULL, source_coverage_complete INTEGER NOT NULL DEFAULT 0)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_processed_signatures (",
    " wallet TEXT NOT NULL, signature TEXT NOT NULL, revision INTEGER NOT NULL,",
    " undecoded_swap INTEGER NOT NULL DEFAULT 0,",
    " PRIMARY KEY(wallet,signature))",
  ].join("\n"));
  if (!db.pragma("table_info(chain_forensic_wallet_sync)").some(column => column.name === "source_coverage_complete")) {
    db.exec("ALTER TABLE chain_forensic_wallet_sync ADD COLUMN source_coverage_complete INTEGER NOT NULL DEFAULT 0");
  }
}
function walletCoverage(row) {
  return row.backfill_complete === 1 && row.possible_gap === 0
    && !row.forward_cursor && row.last_success_at != null && !row.last_error;
}

function rebuildWallet(db, wallet, force = false) {
  initForensics(db);
  const target = db.prepare("SELECT * FROM chain_seed_targets WHERE kind='wallet' AND address=?").get(wallet);
  if (!target) throw new Error("Wallet is not in seed queue: " + wallet);
  const summary = db.prepare("SELECT COUNT(*) AS n,COALESCE(MAX(observed_at),0) AS latest FROM chain_seed_events WHERE kind='wallet' AND address=?").get(wallet);
  const complete = walletCoverage(target);
  const cached = db.prepare("SELECT * FROM chain_forensic_wallet_sync WHERE wallet=?").get(wallet);
  const canIncrement = !force && cached && cached.revision === REVISION;
  if (canIncrement && cached.observed_count === summary.n
    && cached.max_observed_at === summary.latest &&
    Boolean(cached.source_coverage_complete) === complete) {
    return { wallet, skipped: true, transactions: summary.n,
      coverageComplete: Boolean(cached.coverage_complete) };
  }
  const rows = canIncrement ? db.prepare(
    "SELECT e.signature,e.payload_gzip FROM chain_seed_events e " +
    "LEFT JOIN chain_forensic_processed_signatures p ON p.wallet=e.address AND p.signature=e.signature " +
    "WHERE e.kind='wallet' AND e.address=? AND (p.signature IS NULL OR p.revision<>?)"
  ).all(wallet, REVISION) : db.prepare(
    "SELECT signature,payload_gzip FROM chain_seed_events WHERE kind='wallet' AND address=?"
  ).all(wallet);
  const freshlyParsed = [];
  const processed = [];
  for (const row of rows) {
    let tx;
    try { tx = JSON.parse(gunzipSync(row.payload_gzip).toString("utf8")); }
    catch (error) { throw new Error("Invalid cached transaction " + row.signature + ": " + String(error)); }
    if (tx.signature !== row.signature) throw new Error("Cached signature mismatch: " + row.signature);
    const decoded = parseEvidence(tx, wallet);
    const undecoded = tx.transactionError == null && tx.error == null &&
      ((tx.type === "SWAP" && (!tx.events?.swap || decoded.length === 0)) ||
      (tx.type === "UNKNOWN" && !Array.isArray(tx.accountData)));
    processed.push({ signature: row.signature, undecoded });
    freshlyParsed.push(...decoded);
  }
  const historical = canIncrement ? db.prepare(
    "SELECT signature,slot,block_time AS timestamp,leg_index AS event_index,kind,mint," +
    "amount_tokens AS amountTokens,amount_sol AS amountSol,fee_sol AS feeSol,counterparty " +
    "FROM chain_forensic_activities WHERE wallet=?"
  ).all(wallet).map(row => ({...row, index: row.event_index})) : [];
  const events = [...historical, ...freshlyParsed];
  const unknownOld = canIncrement ? db.prepare(
    "SELECT COUNT(*) AS count FROM chain_forensic_processed_signatures " +
    "WHERE wallet=? AND revision=? AND undecoded_swap=1"
  ).get(wallet, REVISION).count > 0 : false;
  const undecodedSwap = unknownOld || processed.some(p => p.undecoded);
  const evidenceComplete = complete && !undecodedSwap;
  const pnl = computePnl(events, evidenceComplete);
  if (undecodedSwap) {
    for (const item of pnl) {
      item.reasons.push("undecoded_swap_in_wallet_history");
      item.status = "unknown";
      item.totalRealizedPnlSol = null;
    }
  }
  const insertEvent = db.prepare(
    "INSERT INTO chain_forensic_activities(wallet,signature,leg_index,slot,block_time,kind,mint,amount_tokens,amount_sol,fee_sol,counterparty) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
  );
  const insertEdge = db.prepare(
    "INSERT INTO chain_forensic_edges(observer_wallet,signature,leg_index,mint,from_wallet,to_wallet,amount_tokens) VALUES(?,?,?,?,?,?,?)"
  );
  const insertPnl = db.prepare(
    "INSERT INTO chain_forensic_wallet_pnl(wallet,mint,coverage_complete,status,buys,sells,transfers,known_sells,known_realized_pnl_sol,total_realized_pnl_sol,unknown_reasons,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  db.transaction(() => {
    if (!canIncrement) {
      db.prepare("DELETE FROM chain_forensic_activities WHERE wallet=?").run(wallet);
      db.prepare("DELETE FROM chain_forensic_edges WHERE observer_wallet=?").run(wallet);
      db.prepare("DELETE FROM chain_forensic_processed_signatures WHERE wallet=?").run(wallet);
    }
    db.prepare("DELETE FROM chain_forensic_wallet_pnl WHERE wallet=?").run(wallet);
    const putSignature = db.prepare("INSERT INTO chain_forensic_processed_signatures(wallet,signature,revision,undecoded_swap) VALUES(?,?,?,?)");
    for (const row of processed) putSignature.run(wallet,row.signature,REVISION,row.undecoded ? 1 : 0);
    for (const ev of freshlyParsed) {
      insertEvent.run(wallet, ev.signature, ev.index, ev.slot, ev.timestamp, ev.kind,
        ev.mint, ev.amountTokens, ev.amountSol, ev.feeSol, ev.counterparty);
      if (["transfer_in", "transfer_out", "sol_transfer_in", "sol_transfer_out"].includes(ev.kind) && ev.counterparty) {
        insertEdge.run(wallet, ev.signature, ev.index, ev.mint,
          ev.kind.endsWith("_out") ? wallet : ev.counterparty,
          ev.kind.endsWith("_in") ? wallet : ev.counterparty, ev.amountTokens);
      }
    }
    const now = Date.now();
    for (const item of pnl) {
      insertPnl.run(wallet, item.mint, evidenceComplete ? 1 : 0, item.status, item.buys,
        item.sells, item.transfers, item.knownSellCount, item.knownRealizedPnlSol,
        item.totalRealizedPnlSol, JSON.stringify(item.reasons), now);
    }
    db.prepare(
      "INSERT INTO chain_forensic_wallet_sync(wallet,revision,observed_count,max_observed_at,coverage_complete,analyzed_at,source_coverage_complete) VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET revision=excluded.revision,observed_count=excluded.observed_count,max_observed_at=excluded.max_observed_at,coverage_complete=excluded.coverage_complete,analyzed_at=excluded.analyzed_at,source_coverage_complete=excluded.source_coverage_complete"
    ).run(wallet, REVISION, summary.n, summary.latest, evidenceComplete ? 1 : 0, now, complete ? 1 : 0);
  })();
  return { wallet, skipped: false, transactions: summary.n, newlyParsed: rows.length, activities: events.length,
    pricedTrades: events.filter(e => e.kind === "buy" || e.kind === "sell").length,
    coverageComplete: evidenceComplete, verifiedTokens: pnl.filter(p => p.status === "verified").length,
    unknownTokens: pnl.filter(p => p.status === "unknown").length };
}

function rebuildAll(db, limit = 100, force = false) {
  initForensics(db);
  const wallets = db.prepare(
    "SELECT address FROM chain_seed_targets WHERE kind='wallet' AND source_mask<>0 ORDER BY priority DESC,address LIMIT ?"
  ).all(limit);
  const completed = [], errors = [];
  for (const row of wallets) {
    try { completed.push(rebuildWallet(db, row.address, force)); }
    catch (e) { errors.push({ wallet: row.address, error: String(e.message || e) }); }
  }
  return { processed: completed.length, errors, wallets: completed,
    totals: db.prepare(
      "SELECT COUNT(*) AS walletsAndMints, SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified, SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown FROM chain_forensic_wallet_pnl"
    ).get() };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex < 0 ? 100 : Number(args[limitIndex + 1]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new Error("Invalid --limit");
  require("dotenv").config({ path: path.join(process.cwd(), ".env.local"), quiet: true });
  require("ts-node").register({ skipProject: true, transpileOnly: true,
    compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true } });
  const db = require("../lib/trade/db").getDb();
  const result = rebuildAll(db, limit, args.includes("--force"));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
module.exports = { initForensics, walletCoverage, rebuildWallet, rebuildAll };
