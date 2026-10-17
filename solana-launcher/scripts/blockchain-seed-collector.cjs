#!/usr/bin/env node
"use strict";

// Local-first import/collection. Run from solana-launcher:
//   node scripts/blockchain-seed-collector.cjs --mode import --migrated-dir ... --trending-dir ... --wallets-dir ...
//   node scripts/blockchain-seed-collector.cjs --mode collect --limit 50 --concurrency 2
// Requires Python 3 for the project's bounded XLSX reader and Alchemy Solana API credentials for collection.
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
// The local CLI does not inherit Next.js environment loading.
require("dotenv").config({ path: path.join(process.cwd(), ".env.local"), quiet: true });
require("dotenv").config({ path: path.join(process.cwd(), ".env"), quiet: true });
const { PRIORITIES, SOURCE_BITS, parseWorkbook, scanFolder, isSolanaAddress } = require("./blockchain-seed-core.cjs");
const walletCache = require("./blockchain-wallet-cache.cjs");
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
let stopRequested = false;
process.once("SIGINT", () => { stopRequested = true; });
process.once("SIGTERM", () => { stopRequested = true; });

function intFlag(value, fallback, min, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error("Invalid numeric flag: " + value);
  return n;
}
function parseArgs(argv) {
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error("Unexpected argument: " + arg);
    const key = arg.slice(2);
    if (["dry-run", "prune-missing", "help"].includes(key)) { flags[key] = true; continue; }
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing --" + key + " value");
    flags[key] = argv[++i];
  }
  const defaultFolder = path.join(process.cwd(), "data", "seed-folders");
  return {
    mode: flags.mode || "import",
    folders: {
      migrated: path.resolve(flags["migrated-dir"] || path.join(defaultFolder, "migrated")),
      dex_trending: path.resolve(flags["trending-dir"] || path.join(defaultFolder, "trending")),
      profitable_wallets: path.resolve(flags["wallets-dir"] || path.join(defaultFolder, "wallets")),
    },
    limit: intFlag(flags.limit, 30, 1, 10000),
    concurrency: intFlag(flags.concurrency, 2, 1, 4),
    recentLimit: intFlag(flags["recent-limit"], 200, 1, 1000),
    backfillLimit: intFlag(flags["backfill-limit"], 200, 1, 1000),
    maxFiles: intFlag(flags["max-files"], 5000, 1, 100000),
    watchInterval: intFlag(flags["watch-interval"], 60, 10, 3600),
    dryRun: Boolean(flags["dry-run"]),
    pruneMissing: Boolean(flags["prune-missing"]),
    help: Boolean(flags.help),
  };
}
function usage() {
  console.log([
    "Blockchain Excel seed collector (local SQLite and Alchemy Solana API)",
    "  --mode import|collect|all|watch|status  [default: import]",
    "  --migrated-dir <folder> --trending-dir <folder> --wallets-dir <folder>",
    "  --limit 30 --concurrency 2 --recent-limit 200 --backfill-limit 200",
    "  --mode watch --watch-interval 60  Repeat import and bounded collection on a laptop",
    "  --dry-run                 Inspect the spreadsheets without writing DB/network",
    "  --prune-missing           Remove mappings for deleted XLSX files",
    "  --max-files 5000",
    "Default folders: data/seed-folders/{migrated,trending,wallets}",
    "Collection requires ALCHEMY_API_KEY(S) or ALCHEMY_SOLANA_RPC_URL. Helius is not a fallback. Existing trade.db is reused.",
  ].join("\n"));
}

function initDb(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec([
    "CREATE TABLE IF NOT EXISTS chain_seed_files (",
    "  file_path TEXT PRIMARY KEY, category TEXT NOT NULL, bytes INTEGER NOT NULL,",
    "  mtime_ms INTEGER NOT NULL, imported_at INTEGER NOT NULL, sheet_count INTEGER NOT NULL,",
    "  rows_scanned INTEGER NOT NULL, targets_found INTEGER NOT NULL)",
    ";CREATE TABLE IF NOT EXISTS chain_seed_file_sources (",
    "  file_path TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL,",
    "  address TEXT NOT NULL, PRIMARY KEY(file_path,category,kind,address))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_seed_sources_target",
    "  ON chain_seed_file_sources(kind,address)",
    ";CREATE TABLE IF NOT EXISTS chain_seed_targets (",
    "  kind TEXT NOT NULL, address TEXT NOT NULL, source_mask INTEGER NOT NULL DEFAULT 0,",
    "  priority INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL DEFAULT 0,",
    "  last_success_at INTEGER, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,",
    "  last_error TEXT, backfill_cursor TEXT, forward_cursor TEXT, backfill_complete INTEGER NOT NULL DEFAULT 0,",
    "  possible_gap INTEGER NOT NULL DEFAULT 0, events_saved INTEGER NOT NULL DEFAULT 0,",
    "  collection_provider TEXT NOT NULL DEFAULT 'alchemy', cursor_version INTEGER NOT NULL DEFAULT 1,",
    "  PRIMARY KEY (kind,address))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_seed_targets_queue",
    "  ON chain_seed_targets(next_run_at,priority,lease_until)",
    ";CREATE TABLE IF NOT EXISTS chain_seed_events (",
    "  kind TEXT NOT NULL, address TEXT NOT NULL, signature TEXT NOT NULL,",
    "  block_time INTEGER, slot INTEGER, payload_gzip BLOB NOT NULL, payload_bytes INTEGER NOT NULL, observed_at INTEGER NOT NULL,",
    "  PRIMARY KEY(kind,address,signature))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_seed_events_latest",
    "  ON chain_seed_events(kind,address,block_time DESC)",
  ].join("\n"));
  const targetColumns = db.pragma("table_info(chain_seed_targets)");
  if (!targetColumns.some(c => c.name === "forward_cursor")) {
    db.exec("ALTER TABLE chain_seed_targets ADD COLUMN forward_cursor TEXT");
  }
  if (!targetColumns.some(c => c.name === "collection_provider")) {
    db.exec("ALTER TABLE chain_seed_targets ADD COLUMN collection_provider TEXT");
  }
  if (!targetColumns.some(c => c.name === "cursor_version")) {
    db.exec("ALTER TABLE chain_seed_targets ADD COLUMN cursor_version INTEGER NOT NULL DEFAULT 0");
  }
  // Helius signature cursors are not Alchemy pagination tokens. Keep old raw
  // events for audit, but invalidate provider-specific progress and completeness.
  db.prepare(`
    UPDATE chain_seed_targets
    SET backfill_cursor=NULL, forward_cursor=NULL, backfill_complete=0,
        possible_gap=0, collection_provider='alchemy', cursor_version=1, next_run_at=0
    WHERE collection_provider IS NULL OR collection_provider<>'alchemy' OR cursor_version<>1
  `).run();
  walletCache.ensureWalletCacheSchema(db);
  // Previously cached wallet history may have been fetched by Helius. Do not
  // let its provider-specific completeness authorize an Alchemy/PnL conclusion.
  if (db.pragma("table_info(chain_wallet_discovery)").some(c => c.name === "history_status")) {
    db.prepare(`
      UPDATE chain_wallet_discovery
      SET history_status='partial', last_fetched_at=NULL,
          decoder_coverage='swap_only', last_error='provider_changed_to_alchemy_revalidation_required'
      WHERE history_status='complete'
    `).run();
  }
}

function refreshTargets(db) {
  const now = Date.now();
  const grouped = db.prepare(
    "SELECT kind,address,group_concat(DISTINCT category) AS categories FROM chain_seed_file_sources GROUP BY kind,address"
  );
  const upsert = db.prepare([
    "INSERT INTO chain_seed_targets(kind,address,source_mask,priority,next_run_at,collection_provider,cursor_version)",
    "VALUES(?,?,?,?,0,'alchemy',1) ON CONFLICT(kind,address) DO UPDATE SET",
    "source_mask=excluded.source_mask,priority=excluded.priority,",
    "next_run_at=CASE WHEN chain_seed_targets.source_mask<>excluded.source_mask",
    "THEN MIN(chain_seed_targets.next_run_at,?) ELSE chain_seed_targets.next_run_at END",
  ].join(" "));
  const tx = db.transaction(() => {
    let count = 0;
    // better-sqlite3 does not permit writes while an .iterate() cursor is open
    // on this connection. Materialize the target keys before upserting.
    for (const row of grouped.all()) {
      const categories = String(row.categories || "").split(",");
      let mask = 0, priority = 0;
      for (const category of categories) {
        mask |= SOURCE_BITS[category] || 0;
        priority = Math.max(priority, PRIORITIES[category] || 0);
      }
      if (!mask) continue;
      upsert.run(row.kind, row.address, mask, priority, now);
      count++;
    }
    // Unschedule targets no longer present in any source file; preserve the
    // existing TTL of unchanged targets instead of refetching all of them.
    db.prepare("UPDATE chain_seed_targets SET source_mask=0,priority=0 "
      + "WHERE NOT EXISTS (SELECT 1 FROM chain_seed_file_sources s "
      + "WHERE s.kind=chain_seed_targets.kind AND s.address=chain_seed_targets.address)").run();
    return count;
  });
  return tx();
}

function importFolders(db, args) {
  const xlsx = require("./xlsx-safe-package/index.cjs");
  const find = db ? db.prepare("SELECT bytes,mtime_ms,category FROM chain_seed_files WHERE file_path=?") : null;
  const putFile = db ? db.prepare([
    "INSERT INTO chain_seed_files(file_path,category,bytes,mtime_ms,imported_at,sheet_count,rows_scanned,targets_found)",
    "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(file_path) DO UPDATE SET",
    "category=excluded.category, bytes=excluded.bytes,mtime_ms=excluded.mtime_ms,",
    "imported_at=excluded.imported_at,sheet_count=excluded.sheet_count,",
    "rows_scanned=excluded.rows_scanned,targets_found=excluded.targets_found",
  ].join(" ")) : null;
  const putTarget = db ? db.prepare(
    "INSERT OR IGNORE INTO chain_seed_file_sources(file_path,category,kind,address) VALUES(?,?,?,?)"
  ) : null;
  const deleteFileTargets = db ? db.prepare("DELETE FROM chain_seed_file_sources WHERE file_path=?") : null;
  const stats = { scannedFiles: 0, changedFiles: 0, unchangedFiles: 0,
    parsedAddresses: 0, invalidRows: 0, missingFolders: [], files: [] };
  const seenPaths = new Set();
  for (const [category, folder] of Object.entries(args.folders)) {
    if (!fs.existsSync(folder)) { stats.missingFolders.push(folder); continue; }
    const files = scanFolder(folder, args.maxFiles);
    for (const file of files) {
      if (stopRequested) break;
      if (seenPaths.has(file)) throw new Error("The same XLSX belongs to more than one category: " + file);
      seenPaths.add(file);
      stats.scannedFiles++;
      const fileStat = fs.statSync(file);
      const mtime = Math.round(fileStat.mtimeMs);
      const previous = find?.get(file);
      if (!args.dryRun && previous && previous.bytes === fileStat.size
          && previous.mtime_ms === mtime && previous.category === category) {
        stats.unchangedFiles++;
        continue;
      }
      // Safe local XLSX reader enforces ZIP and workbook size limits.
      const workbook = xlsx.readFile(file);
      const parsed = parseWorkbook(workbook, category);
      const rows = parsed.sheets.reduce((n, sheet) => n + sheet.inspected, 0);
      const bad = parsed.sheets.reduce((n, sheet) => n + sheet.skipped, 0);
      stats.invalidRows += bad;
      stats.parsedAddresses += parsed.addresses.length;
      stats.changedFiles++;
      stats.files.push({ file: path.basename(file), category, sheets: parsed.sheets,
        uniqueAddresses: parsed.addresses.length });
      if (args.dryRun) continue;
      db.transaction(() => {
        deleteFileTargets.run(file);
        for (const address of parsed.addresses) {
          putTarget.run(file, category, parsed.kind, address);
        }
        putFile.run(file, category, fileStat.size, mtime, Date.now(),
          parsed.sheets.length, rows, parsed.addresses.length);
      })();
    }
  }
  if (!args.dryRun && args.pruneMissing) {
    const old = db.prepare("SELECT file_path FROM chain_seed_files");
    db.transaction(() => {
      const delFile = db.prepare("DELETE FROM chain_seed_files WHERE file_path=?");
      for (const row of old.all()) {
        if (!seenPaths.has(row.file_path) && fs.existsSync(path.dirname(row.file_path))) {
          deleteFileTargets.run(row.file_path);
          delFile.run(row.file_path);
          stats.changedFiles++;
        }
      }
    })();
  }
  if (!args.dryRun && stats.changedFiles) stats.queuedAddresses = refreshTargets(db);
  return stats;
}

function status(db) {
  const targets = db.prepare(
    "SELECT kind,COUNT(*) AS total,SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS synced,"
    + "SUM(CASE WHEN backfill_complete=1 THEN 1 ELSE 0 END) AS complete,"
    + "SUM(CASE WHEN possible_gap=1 THEN 1 ELSE 0 END) AS possibleGaps "
    + "FROM chain_seed_targets WHERE source_mask<>0 GROUP BY kind"
  ).all();
  const categories = db.prepare(
    "SELECT category,COUNT(DISTINCT address) AS addresses FROM chain_seed_file_sources GROUP BY category"
  ).all();
  const files = db.prepare("SELECT COUNT(*) AS count FROM chain_seed_files").get().count;
  return { files, categories, targets, collectedEvents:
    db.prepare("SELECT COUNT(*) AS count FROM chain_seed_events").get().count };
}

function claimOne(db) {
  const now = Date.now();
  return db.transaction(() => {
    const row = db.prepare(
      "SELECT * FROM chain_seed_targets WHERE source_mask<>0 AND next_run_at<=?"
      + " AND (lease_until IS NULL OR lease_until<?)"
      + " AND NOT (kind='wallet' AND EXISTS ("
      + "   SELECT 1 FROM chain_wallet_discovery d WHERE d.wallet=chain_seed_targets.address"
      + "   AND d.history_status='complete' AND d.decoder_coverage='full' AND d.last_fetched_at IS NOT NULL"
      + "   AND (? - d.last_fetched_at) < CASE"
      + "     WHEN d.last_trade_at IS NOT NULL AND d.last_trade_at >= CAST((? - 86400000) / 1000 AS INTEGER)"
      + "     THEN 7200000 ELSE 86400000 END))"
      + " ORDER BY priority DESC, next_run_at ASC, last_success_at ASC LIMIT 1"
    ).get(now, now, now, now);
    // A fresh complete wallet is filtered in SQL; partial/stale histories remain eligible.
    if (!row) return null;
    const leaseUntil = now + 10 * 60_000;
    const updated = db.prepare(
      "UPDATE chain_seed_targets SET lease_until=? WHERE kind=? AND address=?"
      + " AND (lease_until IS NULL OR lease_until<?)"
    ).run(leaseUntil, row.kind, row.address, now);
    return updated.changes === 1 ? { ...row, lease_until: leaseUntil } : null;
  })();
}

function persistEvents(db, kind, address, transactions) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO chain_seed_events"
    + "(kind,address,signature,block_time,slot,payload_gzip,payload_bytes,observed_at)"
    + " VALUES(?,?,?,?,?,?,?,?)"
  );
  let saved = 0;
  db.transaction(() => {
    for (const tx of transactions) {
      if (!tx || typeof tx.signature !== "string" || !tx.signature) continue;
      const serialized = JSON.stringify(tx);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > 512 * 1024) {
        throw new Error("Oversized Alchemy transaction; not silently truncated");
      }
      // Fast gzip reduces laptop disk I/O while retaining the original evidence.
      const packed = gzipSync(Buffer.from(serialized), { level: 1 });
      saved += insert.run(kind, address, tx.signature,
        Number.isFinite(tx.timestamp) ? tx.timestamp : null,
        Number.isFinite(tx.slot) ? tx.slot : null, packed, bytes, Date.now()).changes;
    }
  })();
  return saved;
}

function recordAlchemyUsage(db, row, httpRequests, pagesFetched, lastPageEmpty, stage) {
  const requests = Math.floor(Number(httpRequests) || 0);
  if (requests <= 0) return;
  const common = {
    taskId: row.kind + ":" + row.address,
    entityKind: row.kind,
    entityKey: row.address,
    ts: Date.now(),
    metadata: { pagesFetched: Number(pagesFetched) || 0, lastPageEmpty: Boolean(lastPageEmpty), stage },
  };
  walletCache.recordBudgetUsage(db, {
    ...common,
    provider: "alchemy",
    endpoint: "getTransactionsForAddress",
    costUnits: requests,
    costKind: "http",
  });
  // Alchemy documents getTransactionsForAddress at 100 CUs per RPC request.
  // Keep CU separate from HTTP counts; this includes retries as real requests.
  walletCache.recordBudgetUsage(db, {
    ...common,
    provider: "alchemy",
    endpoint: "getTransactionsForAddress",
    costUnits: requests * 100,
    costKind: "cu",
    metadata: { pagesFetched: Number(pagesFetched) || 0, lastPageEmpty: Boolean(lastPageEmpty), stage,
      cuPerRequest: 100, cuRateSource: "Alchemy Solana getTransactionsForAddress documentation" },
  });
}

function appendDiscovered(db, ownerWallet, transactions, txsToTrades) {
  const discovered = new Set();
  for (const tx of transactions) {
    const swap = tx.events && tx.events.swap;
    const mints = new Set();
    for (const transfer of tx.tokenTransfers || []) {
      if (transfer && (transfer.fromUserAccount === ownerWallet || transfer.toUserAccount === ownerWallet)) {
        mints.add(transfer.mint);
      }
    }
    for (const leg of [...(swap?.tokenInputs || []), ...(swap?.tokenOutputs || [])]) {
      if (leg && leg.userAccount === ownerWallet) mints.add(leg.mint);
    }
    for (const delta of tx.tokenBalanceDeltas || []) {
      if (delta && delta.owner === ownerWallet) mints.add(delta.mint);
    }
    for (const mint of mints) {
      if (!isSolanaAddress(mint) || mint === SOL || mint === USDC) continue;
      // Record wallet-observed token relationships even if the current decoder
      // cannot classify them as swaps. Low-priority token crawl follows this seed.
      discovered.add(mint);
    }
    if (discovered.size >= 25) break;
  }
  if (!discovered.size) return 0;
  const link = db.prepare(
    "INSERT OR IGNORE INTO chain_seed_file_sources(file_path,category,kind,address) VALUES(?,?,?,?)"
  );
  const target = db.prepare([
    "INSERT INTO chain_seed_targets(kind,address,source_mask,priority,next_run_at,collection_provider,cursor_version)",
    "VALUES('token',?,8,40,0,'alchemy',1) ON CONFLICT(kind,address) DO UPDATE SET",
    "source_mask=(chain_seed_targets.source_mask | 8),",
    "priority=MAX(chain_seed_targets.priority,40)",
  ].join(" "));
  const tx = db.transaction(() => {
    let count = 0;
    for (const mint of discovered) {
      const inserted = link.run("@wallet:" + ownerWallet, "discovered", "token", mint);
      if (inserted.changes) count++;
      target.run(mint);
    }
    return count;
  });
  return tx();
}

async function processOne(db, row, cfg, api) {
  const known = new Set(db.prepare(
    "SELECT signature FROM chain_seed_events WHERE kind=? AND address=?"
    + " ORDER BY block_time DESC, observed_at DESC LIMIT 150"
  ).all(row.kind, row.address).map(r => r.signature));
  const recent = await api.fetchTransactionsForAddress(row.address, cfg.recentLimit, known);
  let pagesFetched = recent.pagesFetched || 0;
  let lastPageEmpty = Boolean(recent.lastPageEmpty);
  recordAlchemyUsage(db, row, recent.httpRequests, recent.pagesFetched, recent.lastPageEmpty, "recent");
  const events = [...recent.transactions];
  let backfillCursor = row.backfill_cursor;
  let forwardCursor = row.forward_cursor;
  let complete = Boolean(row.backfill_complete);
  let gap = Boolean(row.possible_gap);

  // A high-volume wallet may accumulate >recentLimit transactions during
  // downtime. Persist the forward catch-up cursor and drain it across runs.
  // The cold-start cap is not a gap: the historical cursor handles that case.
  if (known.size && recent.truncated && !recent.reachedKnownHistory) {
    if (!forwardCursor) forwardCursor = recent.nextCursor || null;
    gap = true;
  }
  if (forwardCursor && known.size) {
    const bridge = await api.fetchTransactionsForAddress(
      row.address, cfg.backfillLimit, known, forwardCursor
    );
    pagesFetched += bridge.pagesFetched || 0;
    lastPageEmpty = Boolean(bridge.lastPageEmpty);
    recordAlchemyUsage(db, row, bridge.httpRequests, bridge.pagesFetched, bridge.lastPageEmpty, "catch_up");
    events.push(...bridge.transactions);
    if (bridge.reachedKnownHistory || bridge.exhausted) {
      forwardCursor = null;
      gap = false;
    } else {
      const next = bridge.nextCursor;
      if (!next || next === forwardCursor) throw new Error("Alchemy catch-up cursor did not advance");
      forwardCursor = next;
    }
  }

  if (!complete && !backfillCursor) {
    backfillCursor = recent.nextCursor || null;
    if (recent.exhausted) complete = true;
  } else if (!complete && backfillCursor) {
    const historical = await api.fetchTransactionsForAddress(
      row.address, cfg.backfillLimit, new Set(), backfillCursor
    );
    pagesFetched += historical.pagesFetched || 0;
    lastPageEmpty = Boolean(historical.lastPageEmpty);
    recordAlchemyUsage(db, row, historical.httpRequests, historical.pagesFetched, historical.lastPageEmpty, "backfill");
    events.push(...historical.transactions);
    if (historical.exhausted) complete = true;
    else {
      const next = historical.nextCursor;
      if (!next || next === backfillCursor) throw new Error("Alchemy backfill cursor did not advance");
      backfillCursor = next;
    }
  }

  const unique = [...new Map(events.filter(tx => tx && tx.signature)
    .map(tx => [tx.signature, tx])).values()];
  const trades = row.kind === "token" ? api.txsToTrades(unique, row.address) : [];
  const cadence = row.priority >= 100 ? 5 * 60_000 :
    row.priority >= 90 ? 15 * 60_000 : row.priority >= 65 ? 6 * 3600_000 : 12 * 3600_000;
  // SQLite savepoints keep raw events and normalized token trades atomic.
  const added = db.transaction(() => {
    const owned = db.prepare("SELECT 1 FROM chain_seed_targets WHERE kind=? AND address=? AND lease_until=? AND lease_until>?")
      .get(row.kind, row.address, row.lease_until, Date.now());
    if (!owned) throw new Error("Collector lease lost before persistence");
    const n = persistEvents(db, row.kind, row.address, unique);
    if (trades.length) {
      api.persistTokenTrades(row.address, trades.map(t => ({
        signature: t.signature, timestamp: t.timestamp, trader: t.trader,
        type: t.type, amountSol: t.amountSol, amountTokens: t.amountTokens,
        priceSol: t.priceSol, slot: t.slot, quoteMint: t.quoteMint,
        quoteAmount: t.quoteAmount, quoteDecimals: t.quoteDecimals,
        quoteUsdValue: t.quoteUsdValue, fee: t.fee, source: t.source,
        jitoTipLamports: t.jitoTipLamports,
      })));
    }
    if (row.kind === "token") api.markTokenTradeChecked(row.address);
    if (row.kind === "wallet") {
      // Cache all decoded swap legs from this wallet history, not just the token that discovered it.
      walletCache.cacheWalletTrades(db, row.address, unique, api.txsToTrades);
      appendDiscovered(db, row.address, unique, api.txsToTrades);
    }
    db.prepare(
      "UPDATE chain_seed_targets SET last_success_at=?,next_run_at=?,lease_until=NULL,"
      + "attempts=0,last_error=NULL,backfill_cursor=?,forward_cursor=?,"
      + "backfill_complete=?,possible_gap=?,events_saved=events_saved+?"
      + " WHERE kind=? AND address=? AND lease_until=?"
    ).run(Date.now(), Date.now() + (complete && !forwardCursor ? cadence : 60_000),
      backfillCursor, forwardCursor, complete ? 1 : 0, gap ? 1 : 0,
      n, row.kind, row.address, row.lease_until);
    if (row.kind === "wallet") {
      walletCache.markWalletHistory(db, row.address, {
        complete, backfillCursor, forwardCursor, possibleGap: gap, now: Date.now(),
        decoderCoverage: 'swap_only', decoderVersion: walletCache.DECODER_VERSION,
        pagesFetched, lastPageEmpty, source: 'alchemy'
      });
    } else {
      const slots = unique.map(tx => Number(tx.slot)).filter(Number.isFinite);
      walletCache.recordHistoryCoverage(db, {
        entityKind: 'token', entityKey: row.address, source: 'alchemy',
        coverageStartSlot: slots.length ? Math.min(...slots) : null,
        coverageEndSlot: slots.length ? Math.max(...slots) : null,
        eventsCount: db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind='token' AND address=?").get(row.address).n,
        expectedCount: null, coveragePercent: null,
        status: gap ? 'gap' : (complete ? 'complete' : 'partial'), decoderCoverage: 'swap_only',
        gapReason: gap ? 'pagination_gap' : (complete ? null : 'backfill_incomplete_or_decoder_limited')
      });
    }
    return n;
  }).immediate();
  return { kind: row.kind, address: row.address, newEvents: added,
    normalizedTrades: trades.length, complete, possibleGap: gap };
}

function failTask(db, row, error) {
  const attempts = row.attempts + 1;
  const jitter = Math.floor(Math.random() * 500);
  const delay = Math.min(3_600_000, 10_000 * (2 ** Math.min(8, attempts))) + jitter;
  db.prepare(
    "UPDATE chain_seed_targets SET attempts=?,last_error=?,next_run_at=?,"
    + "lease_until=NULL WHERE kind=? AND address=? AND lease_until=?"
  ).run(attempts, String(error && error.message || error).slice(0, 400),
    Date.now() + delay, row.kind, row.address, row.lease_until);
}

async function collect(db, args) {
  // ts-node is registered once in main(); avoid stacking require hooks on each
  // watch cycle. Fail fast before reserving work if API keys are unavailable.
  const { createAlchemyProvider } = require("./blockchain-alchemy-provider.cjs");
  const alchemy = createAlchemyProvider();
  const { persistTokenTrades, markTokenTradeChecked } = require("../lib/trade/db");
  const api = { ...alchemy, persistTokenTrades, markTokenTradeChecked };
  const startedAt = Date.now();
  let claimed = 0, succeeded = 0, failed = 0, inserted = 0, gaps = 0;
  async function worker() {
    while (!stopRequested && claimed < args.limit) {
      const row = claimOne(db);
      if (!row) break;
      claimed++;
      try {
        const result = await processOne(db, row, args, api);
        succeeded++;
        inserted += result.newEvents;
        if (result.possibleGap) gaps++;
        if (succeeded % 10 === 0) console.log(JSON.stringify({ progress: succeeded, inserted, failed, gaps }));
      } catch (error) {
        failed++;
        const requestCount = Number(error && error.httpRequests) || 0;
        if (requestCount > 0) {
          try {
            recordAlchemyUsage(db, row, requestCount, error.pagesFetched, error.lastPageEmpty, "failed_request");
          } catch (ledgerError) {
            console.error("[blockchain-collector] failed to record Alchemy HTTP usage:", ledgerError);
          }
        }
        failTask(db, row, error);
        console.error("[blockchain-collector]", row.kind, row.address,
          error instanceof Error ? error.message : String(error));
      }
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  const durationSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  return { claimed, succeeded, failed, newEvents: inserted, possibleGaps: gaps,
    durationSec: Number(durationSec.toFixed(2)),
    targetsPerSecond: Number((succeeded / durationSec).toFixed(2)),
    eventsPerSecond: Number((inserted / durationSec).toFixed(2)),
    stopped: stopRequested };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!["import", "collect", "all", "watch", "status"].includes(args.mode)) throw new Error("Unknown --mode: " + args.mode);
  // In read-only mode no database is opened or changed.
  if (args.dryRun) {
    if (!["import", "all"].includes(args.mode)) throw new Error("--dry-run requires import/all");
    return console.log(JSON.stringify(importFolders(null, args), null, 2));
  }
  require("ts-node").register({
    skipProject: true, transpileOnly: true,
    compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true },
  });
  const db = require("../lib/trade/db").getDb();
  initDb(db);
  if (args.mode === "watch") {
    while (!stopRequested) {
      try {
        const imported = importFolders(db, args);
        const collected = await collect(db, args);
        console.log(JSON.stringify({ watchCycle: new Date().toISOString(), imported, collected, status: status(db) }));
      } catch (error) {
        console.error("[blockchain-collector] watch cycle failed:", error);
        process.exitCode = 1;
        break;
      }
      for (let seconds = 0; seconds < args.watchInterval && !stopRequested; seconds++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return;
  }
  if (args.mode === "import" || args.mode === "all") {
    const imported = importFolders(db, args);
    console.log(JSON.stringify({ import: imported }, null, 2));
  }
  if (args.mode === "collect" || args.mode === "all") {
    console.log(JSON.stringify({ collection: await collect(db, args) }, null, 2));
  }
  console.log(JSON.stringify({ status: status(db) }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
module.exports = { initDb, claimOne, processOne, failTask };
