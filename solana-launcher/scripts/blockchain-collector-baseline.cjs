#!/usr/bin/env node
"use strict";
// Read-only baseline for the existing SQLite collector. No RPC, no migrations,
// no db initialization, no environment credentials and no authoritative claims.
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const MAX_ROWS = 1000;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function one(db, sql) { return db.prepare(sql).get(); }
function percent(n, d) { return d > 0 ? Math.round((n / d) * 10000) / 100 : null; }
function analyze(db, options = {}) {
  const sampleLimit = options.sampleLimit ?? 200;
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > MAX_ROWS) throw new Error("sampleLimit must be 1..1000");
  const tables = ["chain_seed_targets", "chain_seed_events", "chain_seed_raw_revisions", "chain_forensic_history_coverage",
    "chain_wallet_trades", "token_trades", "chain_alchemy_usage_requests", "chain_helius_usage_requests",
    "chain_collection_budget_ledger", "chain_inventory_movements", "chain_dex_indexed_signatures"];
  const present = Object.fromEntries(tables.map(t => [t, tableExists(db, t)]));
  const result = { schema: "blockchain-baseline-v1", diagnosticOnly: true, observedAt: new Date().toISOString(),
    sampleLimit, present, coverage: null, evidence: null, decoding: null, costs: null,
    limitations: ["A SQLite snapshot does not prove complete Solana history.", "Unknown denominators remain null.",
      "This baseline does not establish transaction finality or authoritative PnL."] };
  if (present.chain_seed_targets) {
    const r = one(db, `SELECT COUNT(*) targets,
      COALESCE(SUM(CASE WHEN backfill_complete=1 THEN 1 ELSE 0 END),0) provider_backfill_exhausted,
      COALESCE(SUM(CASE WHEN possible_gap<>0 OR forward_cursor IS NOT NULL THEN 1 ELSE 0 END),0) catchup_pending,
      COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END),0) targets_with_error
      FROM chain_seed_targets`);
    result.coverage = { targets: r.targets, providerBackfillExhausted: r.provider_backfill_exhausted,
      providerBackfillExhaustedPercent: percent(r.provider_backfill_exhausted, r.targets),
      catchupPending: r.catchup_pending, targetsWithError: r.targets_with_error, chainComplete: null };
  }
  if (present.chain_seed_events) {
    const r = one(db, `SELECT COUNT(*) stored_observations,
      COUNT(DISTINCT signature) unique_signatures, MIN(slot) oldest_slot, MAX(slot) newest_slot,
      SUM(CASE WHEN slot IS NULL THEN 1 ELSE 0 END) missing_slots,
      SUM(CASE WHEN block_time IS NULL THEN 1 ELSE 0 END) missing_block_time,
      SUM(CASE WHEN payload_hash IS NULL OR length(payload_hash)<>64 THEN 1 ELSE 0 END) missing_payload_hash
      FROM chain_seed_events`);
    const sample = { analyzed: 0, corrupt: 0, errorMetadataMissing: 0, failedExecution: 0, validMetadata: 0,
      reportedNetworkFeeLamports: "0", invalidNetworkFees: 0, ingestDelayP50Ms: null, ingestDelayP95Ms: null };
    let fee = 0n;
    const delays = [];
    const cursor = db.prepare(`SELECT signature,block_time,observed_at,payload_hash,payload_gzip,payload_bytes FROM chain_seed_events
      ORDER BY kind,address,signature LIMIT ?`);
    for (const row of cursor.iterate(sampleLimit)) {
      sample.analyzed++;
      try {
        if (!Buffer.isBuffer(row.payload_gzip) || !Number.isSafeInteger(row.payload_bytes) ||
          row.payload_bytes <= 0 || row.payload_bytes > MAX_PAYLOAD_BYTES) throw new Error("invalid payload");
        const buffer = gunzipSync(row.payload_gzip, { maxOutputLength: row.payload_bytes });
        if (buffer.length !== row.payload_bytes) throw new Error("payload length");
        if (row.payload_hash && createHash("sha256").update(buffer).digest("hex") !== row.payload_hash) throw new Error("RAW hash mismatch");
        const tx = JSON.parse(buffer.toString("utf8"));
        if (!tx || tx.signature !== row.signature) throw new Error("signature mismatch");
        const raw = tx.raw || tx;
        const meta = raw.meta || raw.transaction?.meta;
        if (!meta || !Object.prototype.hasOwnProperty.call(meta,"err")) { sample.errorMetadataMissing++; continue; }
        sample.validMetadata++;
        if (Number.isSafeInteger(row.block_time) && row.block_time >= 0 &&
          Number.isSafeInteger(row.observed_at) && row.observed_at >= 1e12) {
          delays.push(Math.max(0, row.observed_at-row.block_time*1000));
        }
        if (meta.err !== null) sample.failedExecution++;
        const n = meta.fee;
        if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) fee += BigInt(n);
        else if (typeof n === "string" && /^\d{1,25}$/.test(n)) fee += BigInt(n);
        else sample.invalidNetworkFees++;
      } catch { sample.corrupt++; }
    }
    delays.sort((a,b)=>a-b);
    const quantile = p => delays.length ? delays[Math.ceil(p*delays.length)-1] : null;
    sample.ingestDelayP50Ms = quantile(0.5);
    sample.ingestDelayP95Ms = quantile(0.95);
    sample.reportedNetworkFeeLamports = fee.toString();
    result.evidence = { ...r, sample, sampledFractionPercent: percent(sample.analyzed, r.stored_observations) };
  }
  if (present.chain_seed_raw_revisions) result.rawRevisions = one(db,
    "SELECT COUNT(*) total_revisions, COUNT(DISTINCT signature) signatures_with_revisions FROM chain_seed_raw_revisions");
  if (present.chain_wallet_trades || present.token_trades || present.chain_inventory_movements) {
    const getCount = name => present[name] ? one(db, "SELECT COUNT(*) n FROM " + name).n : null;
    result.decoding = { walletCacheRows: getCount("chain_wallet_trades"), canonicalTrades: getCount("token_trades"),
      inventoryMovementRows: getCount("chain_inventory_movements"), verifiedTradePercent: null,
      decoderCoveragePercent: null, description: "Counts are not evidence of correct trade decoding." };
  }
  if (present.chain_alchemy_usage_requests) {
    result.costs = { alchemy: one(db, `SELECT COUNT(*) attempts, SUM(CASE WHEN http_status=429 THEN 1 ELSE 0 END) rate_limited,
      SUM(CASE WHEN actual_cu IS NULL THEN 1 ELSE 0 END) missing_actual_cu,
      SUM(estimated_cu) estimated_cu_total, SUM(actual_cu) actual_cu_total
      FROM chain_alchemy_usage_requests`), cuPerUsefulUniqueTx: null,
      limitation: "CU per useful transaction requires request-to-unique-evidence attribution." };
  }
  return result;
}
function args(argv) {
  let db = null, sampleLimit = 200;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i+1]) db = argv[++i];
    else if (argv[i] === "--sample" && argv[i+1]) sampleLimit = Number(argv[++i]);
    else throw new Error("Usage: node blockchain-collector-baseline.cjs --db existing.db [--sample 200]");
  }
  if (!db) throw new Error("Explicit --db is required (no implicit production DB).");
  return { db, sampleLimit };
}
function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  const dbPath = path.resolve(a.db);
  if (!fs.existsSync(dbPath)) throw new Error("Database not found");
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, {readonly:true, fileMustExist:true});
  try { db.pragma("query_only=ON"); return analyze(db, a); } finally { db.close(); }
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(),null,2)); }
  catch (e) { console.error(e.message); process.exitCode=1; }
}
module.exports = { analyze, args, main, tableExists };
