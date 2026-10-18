"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const Database = require("better-sqlite3");
const { createAlchemyProvider, normalizeFullTransaction } = require("./blockchain-alchemy-provider.cjs");
const COLUMNS = { slot: "INTEGER", quote_mint: "TEXT", quote_amount: "REAL", quote_decimals: "INTEGER", fee: "REAL" };
function migrate(db) {
  db.transaction(() => {
    const columns = new Set(db.pragma("table_info(token_trades)").map(c => c.name));
    if (!columns.size) throw new Error("token_trades missing");
    for (const [name, type] of Object.entries(COLUMNS)) {
      if (!columns.has(name)) db.exec(`ALTER TABLE token_trades ADD COLUMN ${name} ${type}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS chain_seed_events (
      kind TEXT NOT NULL, address TEXT NOT NULL, signature TEXT NOT NULL,
      block_time INTEGER, slot INTEGER, payload_gzip BLOB NOT NULL,
      payload_bytes INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY(kind,address,signature));
      CREATE INDEX IF NOT EXISTS idx_chain_seed_events_latest
      ON chain_seed_events(kind,address,block_time DESC)`);
  })();
}
async function prepare(dbPath, backupPath) {
  if (path.resolve(dbPath) === path.resolve(backupPath)) throw new Error("Backup must be a separate file");
  // Reserve exclusively: never overwrite an existing backup.
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  let reserved = false;
  try {
    source.prepare("SELECT signature FROM token_trades LIMIT 1").all();
    fs.closeSync(fs.openSync(backupPath, "wx"));
    reserved = true;
    await source.backup(backupPath);
    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Backup integrity check failed");
    } finally { copy.close(); }
  } catch (error) {
    // Keep any partial backup for diagnosis; schema is not touched on failure.
    throw new Error(reserved ? "Backup failed; source schema unchanged" : error.message);
  } finally { source.close(); }
  const db = new Database(dbPath, { fileMustExist: true });
  try { db.pragma("busy_timeout = 5000"); migrate(db); }
  finally { db.close(); }
  return { backupPath, schemaUpdated: true, networkRequests: 0 };
}
function plan(db, mint, limit) {
  const hasEvents = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_seed_events'").get();
  return db.prepare(`SELECT DISTINCT t.signature FROM token_trades t
    WHERE t.mint=? ${hasEvents ? "AND NOT EXISTS (SELECT 1 FROM chain_seed_events e WHERE e.kind='token' AND e.address=t.mint AND e.signature=t.signature)" : ""}
    ORDER BY t.signature LIMIT ?`).all(mint, limit).map(r => r.signature);
}
async function load(db, mint, signatures, rpc) {
  const report = { selected: signatures.length, saved: 0, missing: [], rejected: [], failed: [] };
  const insert = db.prepare(`INSERT OR IGNORE INTO chain_seed_events
    (kind,address,signature,block_time,slot,payload_gzip,payload_bytes,observed_at)
    VALUES('token',?,?,?,?,?,?,?)`);
  for (const signature of signatures) {
    try {
      const reply = await rpc("getTransaction", [signature, {
        encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0,
      }]);
      // Existing provider rpc returns { result, httpRequests }.
      const raw = reply.result;
      if (raw === null) { report.missing.push(signature); continue; }
      if (!raw || raw.transaction?.signatures?.[0] !== signature || !raw.meta
          || !Object.hasOwn(raw.meta, "err") || !Number.isSafeInteger(raw.slot)) {
        report.rejected.push(signature); continue;
      }
      const event = normalizeFullTransaction(raw);
      const payload = Buffer.from(JSON.stringify(event));
      if (payload.length > 512 * 1024) { report.rejected.push(signature); continue; }
      report.saved += insert.run(mint, signature, event.timestamp, event.slot,
        gzipSync(payload, { level: 1 }), payload.length, Date.now()).changes;
    } catch { report.failed.push(signature); }
  }
  return report;
}
function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (["--execute", "--prepare"].includes(key)) a[key.slice(2)] = true;
    else if (["--db", "--backup", "--mint", "--limit"].includes(key) && argv[i+1] && !argv[i+1].startsWith("--")) a[key.slice(2)] = argv[++i];
    else throw new Error("Unknown or incomplete argument: " + key);
  }
  a.limit = Number(a.limit ?? 10);
  if (!Number.isSafeInteger(a.limit) || a.limit < 1 || a.limit > 100) throw new Error("limit must be 1..100 signatures");
  if (!a.db || (a.prepare ? (!a.backup || a.execute) : !a.mint)) throw new Error("Use --db PATH --prepare --backup PATH, or --db PATH --mint MINT [--limit 10] [--execute]");
  return a;
}
async function main() {
  const a = args(process.argv.slice(2));
  if (a.prepare) { console.log(JSON.stringify(await prepare(a.db, a.backup))); return; }
  const db = new Database(a.db, { readonly: !a.execute, fileMustExist: true });
  try {
    const signatures = plan(db, a.mint, a.limit);
    if (!a.execute) { console.log(JSON.stringify({ mode: "offline_plan", signatures, networkRequests: 0 })); return; }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='chain_seed_events'").get()) throw new Error("Run --prepare with backup first");
    require("dotenv").config({ path: path.join(process.cwd(), ".env.local"), quiet: true });
    require("dotenv").config({ path: path.join(process.cwd(), ".env"), quiet: true });
    const report = await load(db, a.mint, signatures, createAlchemyProvider().rpc);
    console.log(JSON.stringify(report));
    if (report.missing.length || report.rejected.length || report.failed.length) process.exitCode = 1;
  } finally { db.close(); }
}
if (require.main === module) main().catch(() => { console.error("Operation failed; check arguments, database/schema and provider configuration. Credentials omitted."); process.exitCode = 1; });
module.exports = { migrate, prepare, plan, load, args };
