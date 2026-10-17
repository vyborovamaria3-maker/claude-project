"use strict";

// Offline/read-only audit. Run from solana-launcher:
// node scripts/blockchain-trade-reconcile.cjs <mint> [max-trades=100000]
const path = require("node:path");
const zlib = require("node:zlib");
const Database = require("better-sqlite3");
const { reconcileTradeEvidence } = require("./blockchain-trade-reconciliation.cjs");

function main() {
  const mint = process.argv[2];
  const limit = Math.max(1, Math.min(1_000_000, Number(process.argv[3]) || 100_000));
  if (!mint) {
    console.error("Usage: node scripts/blockchain-trade-reconcile.cjs <mint> [max-trades=100000]");
    process.exitCode = 2;
    return;
  }
  const dbPath = path.join(process.cwd(), "data", "trade.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (!tables.has("chain_seed_events") || !tables.has("token_trades")) {
      throw new Error("Required tables chain_seed_events/token_trades are missing; run schema setup/collector first.");
    }
    const rawRows = db.prepare(`
      SELECT signature, block_time, slot, payload_gzip
      FROM chain_seed_events WHERE kind='token' AND address=?
      ORDER BY block_time ASC, slot ASC, signature ASC
    `).all(mint);
    const events = rawRows.map((row) => {
      try { return JSON.parse(zlib.gunzipSync(row.payload_gzip).toString("utf8")); }
      catch (error) {
        return { signature: row.signature, slot: row.slot, timestamp: row.block_time,
          transactionError: { unknown: "raw_payload_decode_failed" }, payloadDecodeError: String(error) };
      }
    });
    const allTrades = db.prepare(`
      SELECT signature, timestamp, trader, type, amount_sol AS amountSol,
        amount_tokens AS amountTokens, price_sol AS priceSol, slot, quote_mint AS quoteMint,
        quote_amount AS quoteAmount, quote_decimals AS quoteDecimals, fee, source
      FROM token_trades WHERE mint=?
      ORDER BY timestamp ASC, slot ASC, signature ASC LIMIT ?
    `).all(mint, limit);
    const report = reconcileTradeEvidence({ events, trades: allTrades, mint });
    report.dbPath = dbPath;
    report.tradeLimit = limit;
    report.tradeLimitReached = allTrades.length >= limit;
    report.inventoryMovementRows = tables.has("chain_inventory_movements")
      ? db.prepare("SELECT COUNT(*) AS n FROM chain_inventory_movements WHERE mint=?").get(mint).n
      : null;
    report.rawPayloadDecodeFailures = events.filter((e) => e.payloadDecodeError).map((e) => ({
      signature: e.signature, error: e.payloadDecodeError,
    }));
    report.authority = "diagnostic_only";
    report.historyComplete = false;
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "needs_review" || report.rawPayloadDecodeFailures.length) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
