#!/usr/bin/env node
"use strict";

// Local-first import/collection. Run from solana-launcher:
//   node scripts/blockchain-seed-collector.cjs --mode import --migrated-dir ... --trending-dir ... --wallets-dir ...
//   node scripts/blockchain-seed-collector.cjs --mode collect --limit 50 --concurrency 2
// Requires Python 3 for the project's bounded XLSX reader and Helius keys for collection.
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const { randomUUID, createHash } = require("node:crypto");
// The local CLI does not inherit Next.js environment loading.
require("dotenv").config({ path: path.join(process.cwd(), ".env.local"), quiet: true });
require("dotenv").config({ path: path.join(process.cwd(), ".env"), quiet: true });
const { PRIORITIES, SOURCE_BITS, parseWorkbook, scanFolder, isSolanaAddress } = require("./blockchain-seed-core.cjs");
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
    if (["dry-run", "prune-missing", "help", "scan-mint-addresses"].includes(key)) { flags[key] = true; continue; }
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing --" + key + " value");
    flags[key] = argv[++i];
  }
  const defaultFolder = path.join(process.cwd(), "data", "seed-folders");
  const monthlyBaselineRaw = flags["monthly-credits-used"] ?? (process.env.HELIUS_MONTHLY_CREDITS_USED_BASELINE?.trim() || undefined);
  const monthlyBudgetRaw = flags["monthly-budget-credits"] ?? (process.env.HELIUS_MONTHLY_BUDGET_CREDITS?.trim() || undefined);
  const periodStartDayRaw = flags["budget-period-start-day"] ?? (process.env.HELIUS_BUDGET_PERIOD_START_DAY?.trim() || undefined);
  const parsed = {
    mode: flags.mode || (flags["seed-token"] ? "pilot" : "import"),
    folders: {
      migrated: path.resolve(flags["migrated-dir"] || path.join(defaultFolder, "migrated")),
      dex_trending: path.resolve(flags["trending-dir"] || path.join(defaultFolder, "trending")),
      profitable_wallets: path.resolve(flags["wallets-dir"] || path.join(defaultFolder, "wallets")),
    },
    seedToken: flags["seed-token"] || null,
    limit: intFlag(flags.limit, flags["seed-token"] ? 10000 : 30, 1, 10000),
    maxObjects: intFlag(flags["max-objects"], 10000, 1, 10000),
    concurrency: intFlag(flags.concurrency, 2, 1, 4),
    recentLimit: intFlag(flags["recent-limit"], 200, 1, 1000),
    backfillLimit: intFlag(flags["backfill-limit"], 200, 1, 1000),
    monthlyBudgetCredits: intFlag(monthlyBudgetRaw, 10000000, 1, 100000000000),
    monthlyBudgetConfigured: monthlyBudgetRaw !== undefined,
    monthlyCreditsUsedBaseline: intFlag(monthlyBaselineRaw, 0, 0, 100000000000),
    monthlyCreditsBaselineConfigured: monthlyBaselineRaw !== undefined,
    budgetPeriodStartDay: intFlag(periodStartDayRaw, 1, 1, 31),
    budgetPeriodStartDayConfigured: periodStartDayRaw !== undefined,
    runBudgetCredits: intFlag(flags["run-budget-credits"] ?? process.env.HELIUS_RUN_BUDGET_CREDITS, 250000, 1, 100000000000),
    pageCreditEstimate: intFlag(flags["page-credit-estimate"] ?? process.env.HELIUS_ADDRESS_TX_ESTIMATED_CREDITS_PER_REQUEST, 110, 1, 1000000),
    maxFiles: intFlag(flags["max-files"], 5000, 1, 100000),
    watchInterval: intFlag(flags["watch-interval"], 60, 10, 3600),
    dryRun: Boolean(flags["dry-run"]),
    pruneMissing: Boolean(flags["prune-missing"]),
    scanMintAddresses: Boolean(flags["scan-mint-addresses"]),
    help: Boolean(flags.help),
  };
  if (parsed.seedToken && !isSolanaAddress(parsed.seedToken)) throw new Error("--seed-token must be a valid Solana mint address");
  if (parsed.mode === "pilot" && !parsed.seedToken) throw new Error("--mode pilot requires --seed-token <mint>");
  if (parsed.seedToken && !["pilot","collect","watch"].includes(parsed.mode)) {
    throw new Error("--seed-token is only valid with --mode pilot|collect|watch");
  }
  return parsed;
}
function usage() {
  console.log([
    "Blockchain Excel seed collector (local SQLite and Helius)",
    "  --mode import|collect|all|watch|pilot|status  [default: import]",
    "  --seed-token <mint>     Start/resume a recursive pilot scoped to one token; does not import Excel seeds",
    "  --limit 30 --max-objects 10000 --concurrency 2 --recent-limit 200 --backfill-limit 200",
    "  --monthly-budget-credits 10000000 --monthly-credits-used <dashboard-used-credits> --budget-period-start-day 1",
    "  --run-budget-credits 250000 --page-credit-estimate 110",
    "  Credit estimates are local guards; provider-reported headers override estimates when available.",
    "  Network modes require --monthly-credits-used or HELIUS_MONTHLY_CREDITS_USED_BASELINE.",
    "  --mode watch --watch-interval 60  Repeat import and bounded collection on a laptop",
    "  --dry-run                 Inspect the spreadsheets without writing DB/network",
    "  --prune-missing           Remove mappings for deleted XLSX files",
    "  --max-files 5000",
    "  --scan-mint-addresses    Diagnostic mint-account traffic (off by default, not a complete trade tape)",
    "Default folders: data/seed-folders/{migrated,trending,wallets}",
    "Collection requires HELIUS_API_KEY or HELIUS_API_KEYS. Existing trade.db is reused.",
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
    "  possible_gap INTEGER NOT NULL DEFAULT 0, events_saved INTEGER NOT NULL DEFAULT 0, lease_token TEXT,",
    "  PRIMARY KEY (kind,address))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_seed_targets_queue",
    "  ON chain_seed_targets(next_run_at,priority,lease_until)",
    ";CREATE TABLE IF NOT EXISTS chain_seed_events (",
    "  kind TEXT NOT NULL, address TEXT NOT NULL, signature TEXT NOT NULL,",
    "  block_time INTEGER, slot INTEGER, payload_gzip BLOB NOT NULL, payload_bytes INTEGER NOT NULL, observed_at INTEGER NOT NULL,",
    "  payload_hash TEXT, raw_revision INTEGER NOT NULL DEFAULT 1,",
    "  PRIMARY KEY(kind,address,signature))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_seed_events_latest",
    "  ON chain_seed_events(kind,address,block_time DESC)",
    ";CREATE TABLE IF NOT EXISTS chain_collection_scopes (",
    "  scope_id TEXT PRIMARY KEY, seed_token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',",
    "  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_run_id TEXT)",
    ";CREATE TABLE IF NOT EXISTS chain_collection_scope_members (",
    "  scope_id TEXT NOT NULL, kind TEXT NOT NULL, address TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,",
    "  reason TEXT NOT NULL, discovered_from_kind TEXT, discovered_from_address TEXT, discovered_at INTEGER NOT NULL,",
    "  PRIMARY KEY(scope_id,kind,address))",
    ";CREATE INDEX IF NOT EXISTS idx_chain_scope_members_queue",
    "  ON chain_collection_scope_members(scope_id,priority DESC,discovered_at,kind,address)",
    ";CREATE TABLE IF NOT EXISTS chain_collection_runs (",
    "  run_id TEXT PRIMARY KEY, scope_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,",
    "  run_budget_credits INTEGER NOT NULL, monthly_budget_credits INTEGER NOT NULL,",
    "  monthly_baseline_credits INTEGER NOT NULL DEFAULT 0, budget_period_start_day INTEGER NOT NULL DEFAULT 1,",
    "  page_credit_estimate INTEGER NOT NULL, max_objects INTEGER NOT NULL,",
    "  status TEXT NOT NULL DEFAULT 'running', stopped_reason TEXT)",
    ";CREATE INDEX IF NOT EXISTS idx_chain_collection_runs_started ON chain_collection_runs(started_at DESC)",
    ";CREATE TABLE IF NOT EXISTS chain_helius_usage_requests (",
    "  request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, month_key TEXT NOT NULL,",
    "  task_kind TEXT NOT NULL, task_address TEXT NOT NULL, endpoint TEXT NOT NULL,",
    "  estimated_credits INTEGER NOT NULL, actual_credits INTEGER, status TEXT NOT NULL DEFAULT 'reserved',",
    "  http_status INTEGER, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)",
    ";CREATE INDEX IF NOT EXISTS idx_chain_helius_usage_month ON chain_helius_usage_requests(month_key,created_at)",
    ";CREATE INDEX IF NOT EXISTS idx_chain_helius_usage_run ON chain_helius_usage_requests(run_id,created_at)",
  ].join("\n"));
  if (!db.pragma("table_info(chain_seed_targets)").some(c => c.name === "forward_cursor")) {
    db.exec("ALTER TABLE chain_seed_targets ADD COLUMN forward_cursor TEXT");
  }
  // Existing wallet cursors were built without token-account coverage.
  // Invalidate them once rather than falsely declaring the old scan complete.
  if (!db.pragma("table_info(chain_seed_targets)").some(c => c.name === "wallet_history_mode")) {
    db.exec("ALTER TABLE chain_seed_targets ADD COLUMN wallet_history_mode TEXT");
    db.prepare("UPDATE chain_seed_targets SET backfill_complete=0,backfill_cursor=NULL,forward_cursor=NULL,possible_gap=1,last_success_at=NULL,next_run_at=0 WHERE kind=\'wallet\'").run();
  }
  if (!db.pragma("table_info(chain_seed_targets)").some(c => c.name === "lease_token"))
    db.exec("ALTER TABLE chain_seed_targets ADD COLUMN lease_token TEXT");
  if (!db.pragma("table_info(chain_seed_events)").some(c => c.name === "payload_hash"))
    db.exec("ALTER TABLE chain_seed_events ADD COLUMN payload_hash TEXT");
  if (!db.pragma("table_info(chain_seed_events)").some(c => c.name === "raw_revision"))
    db.exec("ALTER TABLE chain_seed_events ADD COLUMN raw_revision INTEGER NOT NULL DEFAULT 1");
  if (!db.pragma("table_info(chain_collection_runs)").some(c => c.name === "monthly_baseline_credits"))
    db.exec("ALTER TABLE chain_collection_runs ADD COLUMN monthly_baseline_credits INTEGER NOT NULL DEFAULT 0");
  if (!db.pragma("table_info(chain_collection_runs)").some(c => c.name === "budget_period_start_day"))
    db.exec("ALTER TABLE chain_collection_runs ADD COLUMN budget_period_start_day INTEGER NOT NULL DEFAULT 1");
}


function currentMonthKey(at = Date.now(), periodStartDay = 1) {
  const date=new Date(at);
  let year=date.getUTCFullYear(),month=date.getUTCMonth();
  const effectiveDay=Math.min(periodStartDay,new Date(Date.UTC(year,month+1,0)).getUTCDate());
  if(date.getUTCDate()<effectiveDay){month--;if(month<0){month=11;year--;}}
  if(periodStartDay===1)return String(year)+"-"+String(month+1).padStart(2,"0");
  const startDay=Math.min(periodStartDay,new Date(Date.UTC(year,month+1,0)).getUTCDate());
  return new Date(Date.UTC(year,month,startDay)).toISOString().slice(0,10);
}

function resolveBudgetSettings(db, args, requireBaseline = false, at = Date.now()) {
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const hasRuns = exists("chain_collection_runs");
  const latest = hasRuns ? db.prepare(
    "SELECT monthly_budget_credits,monthly_baseline_credits,budget_period_start_day,started_at FROM chain_collection_runs ORDER BY started_at DESC LIMIT 1"
  ).get() : null;
  if (latest) {
    if (!args.budgetPeriodStartDayConfigured) args.budgetPeriodStartDay = latest.budget_period_start_day ?? 1;
    if (!args.monthlyBudgetConfigured) args.monthlyBudgetCredits = latest.monthly_budget_credits ?? args.monthlyBudgetCredits;
  }
  const periodStartDay = args.budgetPeriodStartDay ?? 1;
  const periodKey = currentMonthKey(at,periodStartDay);
  if (!args.monthlyCreditsBaselineConfigured && hasRuns) {
    const priorRuns = db.prepare(
      "SELECT started_at,monthly_baseline_credits,budget_period_start_day FROM chain_collection_runs " +
      "WHERE budget_period_start_day=? ORDER BY started_at DESC"
    ).all(periodStartDay);
    const currentPeriodRun = priorRuns.find(run =>
      currentMonthKey(run.started_at,run.budget_period_start_day ?? 1) === periodKey
    );
    if (currentPeriodRun) {
      args.monthlyCreditsUsedBaseline = currentPeriodRun.monthly_baseline_credits;
      args.monthlyCreditsBaselineConfigured = true;
    }
  }
  if (requireBaseline && !args.monthlyCreditsBaselineConfigured) {
    throw new Error(
      "No Helius credit baseline is saved for the current billing period. " +
      "Check Helius Dashboard and start once with --monthly-credits-used <credits-already-used>."
    );
  }
  return args;
}

function budgetError(message) {
  const error = new Error(message);
  error.code = "HELIUS_BUDGET_EXCEEDED";
  return error;
}
function addScopeMember(db, scopeId, kind, address, priority, reason, fromKind = null, fromAddress = null) {
  const now = Date.now();
  const work = () => {
    db.prepare(
      "INSERT INTO chain_seed_targets(kind,address,source_mask,priority,next_run_at) VALUES(?,?,8,?,0) " +
      "ON CONFLICT(kind,address) DO UPDATE SET source_mask=(chain_seed_targets.source_mask | 8)," +
      "priority=MAX(chain_seed_targets.priority,excluded.priority),next_run_at=MIN(chain_seed_targets.next_run_at,excluded.next_run_at)"
    ).run(kind,address,priority);
    db.prepare(
      "INSERT INTO chain_collection_scope_members(scope_id,kind,address,priority,reason,discovered_from_kind,discovered_from_address,discovered_at) " +
      "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,kind,address) DO UPDATE SET " +
      "priority=MAX(chain_collection_scope_members.priority,excluded.priority)," +
      "reason=CASE WHEN excluded.priority>chain_collection_scope_members.priority THEN excluded.reason ELSE chain_collection_scope_members.reason END"
    ).run(scopeId,kind,address,priority,reason,fromKind,fromAddress,now);
    db.prepare(
      "INSERT OR IGNORE INTO chain_seed_file_sources(file_path,category,kind,address) VALUES(?,?,?,?)"
    ).run("@scope:"+scopeId,"discovered",kind,address);
  };
  if (db.inTransaction) return work();
  return db.transaction(work)();
}
function ensurePilotScope(db, seedToken) {
  if (!isSolanaAddress(seedToken)) throw new Error("Invalid pilot seed token");
  const scopeId = "seed-token:" + seedToken;
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO chain_collection_scopes(scope_id,seed_token,status,created_at,updated_at) VALUES(?,?,'active',?,?) " +
      "ON CONFLICT(scope_id) DO UPDATE SET status='active',updated_at=excluded.updated_at"
    ).run(scopeId,seedToken,now,now);
    addScopeMember(db,scopeId,"token",seedToken,1000,"seed_token",null,null);
  }).immediate();
  return scopeId;
}
function startCollectionRun(db, args, scopeId = null) {
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO chain_collection_runs(run_id,scope_id,started_at,run_budget_credits,monthly_budget_credits,monthly_baseline_credits,budget_period_start_day,page_credit_estimate,max_objects,status) " +
    "VALUES(?,?,?,?,?,?,?,?,?,'running')"
  ).run(runId,scopeId,now,args.runBudgetCredits,args.monthlyBudgetCredits,
    args.monthlyCreditsUsedBaseline??0,args.budgetPeriodStartDay??1,args.pageCreditEstimate,Math.min(args.limit,args.maxObjects));
  if (scopeId) db.prepare("UPDATE chain_collection_scopes SET last_run_id=?,updated_at=? WHERE scope_id=?")
    .run(runId,now,scopeId);
  return runId;
}
function reserveHeliusCredits(db, input) {
  const requestId = randomUUID();
  const now = Date.now();
  const credits = Number(input.estimatedCredits);
  if (!Number.isSafeInteger(credits) || credits < 1) throw new Error("Invalid estimated Helius request credits");
  return db.transaction(() => {
    const run = db.prepare("SELECT * FROM chain_collection_runs WHERE run_id=?").get(input.runId);
    if (!run || run.status !== "running") throw budgetError("Collection run is not active; no new Helius requests allowed");
    const monthKey = currentMonthKey(now,run.budget_period_start_day??1);
    const runUsed = db.prepare(
      "SELECT COALESCE(SUM(COALESCE(actual_credits,estimated_credits)),0) AS n FROM chain_helius_usage_requests WHERE run_id=?"
    ).get(input.runId).n;
    const monthUsed = run.monthly_baseline_credits + db.prepare(
      "SELECT COALESCE(SUM(COALESCE(actual_credits,estimated_credits)),0) AS n FROM chain_helius_usage_requests WHERE month_key=?"
    ).get(monthKey).n;
    if (runUsed + credits > run.run_budget_credits) {
      throw budgetError("Run Helius credit budget reached ("+runUsed+"/"+run.run_budget_credits+"); pausing before next request");
    }
    if (monthUsed + credits > run.monthly_budget_credits) {
      throw budgetError("Monthly Helius credit budget reached ("+monthUsed+"/"+run.monthly_budget_credits+"); pausing before next request");
    }
    db.prepare(
      "INSERT INTO chain_helius_usage_requests(request_id,run_id,month_key,task_kind,task_address,endpoint,estimated_credits,status,created_at) " +
      "VALUES(?,?,?,?,?,?,?,'reserved',?)"
    ).run(requestId,input.runId,monthKey,input.taskKind,input.taskAddress,input.endpoint,credits,now);
    return requestId;
  }).immediate();
}
function recordHeliusResponse(db, requestId, response) {
  if (!requestId) return;
  db.prepare(
    "UPDATE chain_helius_usage_requests SET status=?,http_status=?,actual_credits=?,finished_at=? WHERE request_id=?"
  ).run(response.status >= 200 && response.status < 300 ? "completed" : "http_error",
    response.status,response.actualCredits,Date.now(),requestId);
}
function recordHeliusError(db, requestId, error) {
  if (!requestId) return;
  db.prepare(
    "UPDATE chain_helius_usage_requests SET status='request_error',error=?,finished_at=? WHERE request_id=?"
  ).run(String(error && error.message || error).slice(0,400),Date.now(),requestId);
}
function releaseTaskForBudget(db, row) {
  db.prepare(
    "UPDATE chain_seed_targets SET lease_until=NULL,lease_token=NULL,next_run_at=?,last_error=NULL " +
    "WHERE kind=? AND address=? AND lease_token IS ?"
  ).run(Date.now(),row.kind,row.address,row.lease_token??null);
}
function finishCollectionRun(db, runId, status, reason = null) {
  db.prepare("UPDATE chain_collection_runs SET status=?,stopped_reason=?,finished_at=? WHERE run_id=?")
    .run(status,reason,Date.now(),runId);
  db.prepare("UPDATE chain_collection_scopes SET status=?,updated_at=? WHERE last_run_id=?")
    .run(status==="budget_paused" ? "paused_budget" : status==="failed" ? "failed" : "active",Date.now(),runId);
}
function requestHooksForTask(db, runId, row, args) {
  return {
    estimatedCreditsPerRequest: args.pageCreditEstimate,
    beforeRequest: context => reserveHeliusCredits(db,{
      runId,taskKind:row.kind,taskAddress:row.address,endpoint:context.endpoint,
      estimatedCredits:context.estimatedCredits,budgetPeriodStartDay:args.budgetPeriodStartDay??1,
    }),
    afterResponse: (requestId,response) => recordHeliusResponse(db,requestId,response),
    onError: (requestId,error) => recordHeliusError(db,requestId,error),
  };
}
function usageStatus(db, args = {}) {
  resolveBudgetSettings(db,args,false);
  const periodStartDay=args.budgetPeriodStartDay??1;
  const monthKey = currentMonthKey(Date.now(),periodStartDay);
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!hasTable("chain_helius_usage_requests")) {
    const monthlyBudgetCredits=args.monthlyBudgetCredits??10000000;
    const baselineCredits=args.monthlyCreditsUsedBaseline??0;
    return {monthKey,monthlyBudgetCredits,baselineCredits,
      baselineConfigured:args.monthlyCreditsBaselineConfigured===true,localTrackedCredits:0,
      usedCredits:baselineCredits,remainingCredits:Math.max(0,monthlyBudgetCredits-baselineCredits),
      requests:0,providerReportedRequests:0,
      note:args.monthlyCreditsBaselineConfigured===true?"No Helius request ledger yet":"Set --monthly-credits-used from Helius Dashboard before collection"};
  }
  const usage = db.prepare(
    "SELECT COALESCE(SUM(COALESCE(actual_credits,estimated_credits)),0) AS used,"+
    "COUNT(*) AS requests,SUM(CASE WHEN actual_credits IS NOT NULL THEN 1 ELSE 0 END) AS reported "+
    "FROM chain_helius_usage_requests WHERE month_key=?"
  ).get(monthKey);
  const monthlyBudgetCredits = args.monthlyBudgetCredits ?? 10000000;
  const baselineCredits = args.monthlyCreditsUsedBaseline ?? 0;
  const usedCredits = baselineCredits + usage.used;
  return {monthKey,monthlyBudgetCredits,baselineCredits,
    baselineConfigured:args.monthlyCreditsBaselineConfigured===true,localTrackedCredits:usage.used,usedCredits,
    remainingCredits:Math.max(0,monthlyBudgetCredits-usedCredits),requests:usage.requests,
    providerReportedRequests:usage.reported,estimatedOnlyRequests:usage.requests-(usage.reported||0),
    note:args.monthlyCreditsBaselineConfigured===true?undefined:"Set --monthly-credits-used from Helius Dashboard before collection"};
}

function refreshTargets(db) {
  const now = Date.now();
  const grouped = db.prepare(
    "SELECT kind,address,group_concat(DISTINCT category) AS categories FROM chain_seed_file_sources GROUP BY kind,address"
  );
  const upsert = db.prepare([
    "INSERT INTO chain_seed_targets(kind,address,source_mask,priority,next_run_at)",
    "VALUES(?,?,?,?,0) ON CONFLICT(kind,address) DO UPDATE SET",
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

function syncDexProgramSources(db, raw = process.env.CHAIN_DEX_PROGRAM_IDS || "") {
  const {configuredDexPrograms} = require("./blockchain-dex-index.cjs");
  const wanted = configuredDexPrograms(raw);
  const filePath = "@config:dex-programs";
  const current = db.prepare("SELECT address FROM chain_seed_file_sources WHERE file_path=? AND kind='dex_program' ORDER BY address")
    .all(filePath).map(row=>row.address);
  if (JSON.stringify(current) === JSON.stringify([...wanted].sort())) return { changed:false, programs:wanted };
  db.transaction(()=>{
    db.prepare("DELETE FROM chain_seed_file_sources WHERE file_path=?").run(filePath);
    const add=db.prepare("INSERT INTO chain_seed_file_sources(file_path,category,kind,address) VALUES(?,?,?,?)");
    for (const program of wanted) add.run(filePath,"dex_program","dex_program",program);
    refreshTargets(db);
  })();
  return { changed:true, programs:wanted };
}
function status(db, args = {}) {
  const targets = db.prepare(
    "SELECT kind,COUNT(*) AS total,SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS synced,"
    + "SUM(CASE WHEN backfill_complete=1 THEN 1 ELSE 0 END) AS providerExhausted,"
    + "SUM(CASE WHEN possible_gap=1 THEN 1 ELSE 0 END) AS possibleGaps "
    + "FROM chain_seed_targets WHERE source_mask<>0 GROUP BY kind"
  ).all();
  const categories = db.prepare(
    "SELECT category,COUNT(DISTINCT address) AS addresses FROM chain_seed_file_sources GROUP BY category"
  ).all();
  const files = db.prepare("SELECT COUNT(*) AS count FROM chain_seed_files").get().count;
  let verified = null;
  try {
    verified = db.prepare("SELECT COUNT(*) AS walletMints, SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verifiedPnl, SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknownPnl FROM chain_forensic_wallet_pnl").get();
  } catch { /* Forensics tables are initialized on the first wallet replay. */ }
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  let scopes = [];
  if (hasTable("chain_collection_scopes")) {
    scopes = db.prepare(
      "SELECT s.scope_id AS scopeId,s.seed_token AS seedToken,s.status,"+
      "COUNT(m.address) AS objects,SUM(CASE WHEN t.last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS syncedObjects "+
      "FROM chain_collection_scopes s LEFT JOIN chain_collection_scope_members m ON m.scope_id=s.scope_id "+
      "LEFT JOIN chain_seed_targets t ON t.kind=m.kind AND t.address=m.address GROUP BY s.scope_id ORDER BY s.created_at DESC"
    ).all();
  }
  return {
    files,categories,targets,collectedEvents:db.prepare("SELECT COUNT(*) AS count FROM chain_seed_events").get().count,
    forensic:verified,budget:usageStatus(db,args),scopes,
    queue:db.prepare(
      "SELECT kind,COUNT(*) AS total,SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,"+
      "SUM(CASE WHEN lease_until IS NOT NULL AND lease_until>? THEN 1 ELSE 0 END) AS leased "+
      "FROM chain_seed_targets WHERE source_mask<>0 GROUP BY kind"
    ).all(Date.now()),
  };
}
function claimOne(db, includeMintAddresses = true, scopeId = null) {
  const now = Date.now();
  return db.transaction(() => {
    const row = scopeId
      ? db.prepare(
        "SELECT t.*,m.priority AS scope_priority FROM chain_seed_targets t "+
        "INNER JOIN chain_collection_scope_members m ON m.kind=t.kind AND m.address=t.address AND m.scope_id=? "+
        "WHERE t.source_mask<>0 AND (?=1 OR t.kind<>'token') AND t.next_run_at<=? "+
        "AND (t.lease_until IS NULL OR t.lease_until<?) "+
        "ORDER BY m.priority DESC,t.next_run_at ASC,t.last_success_at ASC LIMIT 1"
      ).get(scopeId,includeMintAddresses?1:0,now,now)
      : db.prepare(
        "SELECT * FROM chain_seed_targets WHERE source_mask<>0 AND (?=1 OR kind<>'token') AND next_run_at<=?"
        + " AND (lease_until IS NULL OR lease_until<?)"
        + " ORDER BY priority DESC, next_run_at ASC, last_success_at ASC LIMIT 1"
      ).get(includeMintAddresses ? 1 : 0, now, now);
    if (!row) return null;
    const leaseToken = randomUUID();
    const updated = db.prepare(
      "UPDATE chain_seed_targets SET lease_until=?,lease_token=? WHERE kind=? AND address=?"
      + " AND (lease_until IS NULL OR lease_until<?)"
    ).run(now + 30 * 60_000, leaseToken, row.kind, row.address, now);
    return updated.changes === 1 ? { ...row, lease_token: leaseToken } : null;
  }).immediate();
}
function persistEvents(db, kind, address, transactions) {
  const insert = db.prepare(
    "INSERT INTO chain_seed_events"
    + "(kind,address,signature,block_time,slot,payload_gzip,payload_bytes,observed_at,payload_hash,raw_revision)"
    + " VALUES(?,?,?,?,?,?,?,?,?,1)"
    + " ON CONFLICT(kind,address,signature) DO UPDATE SET"
    + " block_time=excluded.block_time,slot=excluded.slot,payload_gzip=excluded.payload_gzip,"
    + " payload_bytes=excluded.payload_bytes,observed_at=excluded.observed_at,"
    + " payload_hash=excluded.payload_hash,raw_revision=chain_seed_events.raw_revision+1"
    + " WHERE chain_seed_events.payload_hash IS NOT excluded.payload_hash"
  );
  let saved = 0;
  db.transaction(() => {
    for (const tx of transactions) {
      if (!tx || typeof tx.signature !== "string" || !tx.signature) continue;
      const serialized = JSON.stringify(tx);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > 512 * 1024) {
        throw new Error("Oversized Helius transaction; not silently truncated");
      }
      // Fast gzip reduces laptop disk I/O while retaining the original evidence.
      const packed = gzipSync(Buffer.from(serialized), { level: 1 });
      const hash = createHash("sha256").update(serialized).digest("hex");
      saved += insert.run(kind, address, tx.signature,
        Number.isFinite(tx.timestamp) ? tx.timestamp : null,
        Number.isFinite(tx.slot) ? tx.slot : null, packed, bytes, Date.now(), hash).changes;
    }
  })();
  return saved;
}

function appendDiscovered(db, ownerWallet, transactions, scopeId = null) {
  const { parseEvidence } = require("./blockchain-forensics-core.cjs");
  const discovered = new Map();
  const addMint = (mint, priority, reason) => {
    if (!isSolanaAddress(mint) || mint === SOL || mint === USDC) return;
    const prior = discovered.get(mint);
    if (!prior || priority > prior.priority) discovered.set(mint,{priority,reason});
  };
  for (const tx of transactions) {
    // Parsed swaps are the strongest token-discovery evidence.
    for (const event of parseEvidence(tx, ownerWallet)) {
      if (event.kind === "buy" || event.kind === "sell") addMint(event.mint,700,"wallet_trade");
    }
    // In the seed-token pilot, follow tokens received/sent through transfers
    // too; these are discovery edges, not proof of a trade or PnL.
    if (scopeId) {
      for (const transfer of tx?.tokenTransfers || []) addMint(transfer?.mint,500,"wallet_token_transfer");
      for (const side of [...(tx?.events?.swap?.tokenInputs || []),...(tx?.events?.swap?.tokenOutputs || [])]) {
        addMint(side?.mint,700,"wallet_swap");
      }
    }
  }
  if (!discovered.size) return 0;
  const link = db.prepare(
    "INSERT OR IGNORE INTO chain_seed_file_sources(file_path,category,kind,address) VALUES(?,?,?,?)"
  );
  const target = db.prepare([
    "INSERT INTO chain_seed_targets(kind,address,source_mask,priority,next_run_at)",
    "VALUES('token',?,8,40,0) ON CONFLICT(kind,address) DO UPDATE SET",
    "source_mask=(chain_seed_targets.source_mask | 8),",
    "priority=MAX(chain_seed_targets.priority,excluded.priority)",
  ].join(" "));
  return db.transaction(() => {
    let count = 0;
    for (const [mint,info] of discovered) {
      count += link.run("@wallet:" + ownerWallet, "discovered", "token", mint).changes;
      target.run(mint);
      if (scopeId) addScopeMember(db,scopeId,"token",mint,info.priority,info.reason,"wallet",ownerWallet);
    }
    return count;
  })();
}

function appendDiscoveredWallets(db, ownerKind, ownerAddress, transactions, scopeId) {
  if (!scopeId) return 0;
  const { parseEvidence } = require("./blockchain-forensics-core.cjs");
  const candidates = new Map();
  const add = (address,priority,reason) => {
    if (!isSolanaAddress(address) || address === ownerAddress || address === SOL || address === USDC) return;
    const old=candidates.get(address);
    if (!old || priority>old.priority) candidates.set(address,{priority,reason});
  };
  for (const tx of transactions) {
    if (!tx || tx.transactionError != null || tx.error != null) continue;
    if (ownerKind === "token") {
      const swap=tx.events?.swap;
      const swapTouchesToken=[...(swap?.tokenInputs||[]),...(swap?.tokenOutputs||[])].some(x=>x?.mint===ownerAddress);
      if (swapTouchesToken) {
        for (const x of [...(swap?.tokenInputs||[]),...(swap?.tokenOutputs||[])]) {
          if (x?.mint===ownerAddress) add(x.userAccount,800,"token_trade_participant");
        }
        // Fee payer is useful as a candidate, but may be a relayer rather than
        // the trader, so its priority is intentionally below userAccount.
        add(tx.feePayer,600,"token_trade_fee_payer");
      }
      for (const transfer of tx.tokenTransfers||[]) {
        if (transfer?.mint!==ownerAddress) continue;
        add(transfer.fromUserAccount,500,"token_transfer_sender");
        add(transfer.toUserAccount,500,"token_transfer_recipient");
      }
    } else if (ownerKind === "wallet") {
      for (const transfer of tx.tokenTransfers||[]) {
        add(transfer?.fromUserAccount,500,"wallet_token_transfer_counterparty");
        add(transfer?.toUserAccount,500,"wallet_token_transfer_counterparty");
      }
      for (const transfer of tx.nativeTransfers||[]) {
        add(transfer?.fromUserAccount,300,"wallet_sol_transfer_counterparty");
        add(transfer?.toUserAccount,300,"wallet_sol_transfer_counterparty");
      }
      // A swap can expose owner accounts even when the transfer summary is
      // sparse. Do not infer ownership from token-account addresses.
      const swap=tx.events?.swap;
      for (const x of [...(swap?.tokenInputs||[]),...(swap?.tokenOutputs||[])]) {
        if (x?.userAccount && x.userAccount!==ownerAddress) add(x.userAccount,650,"wallet_swap_counterparty");
      }
      // Keep parser invocation as a validation path; PnL itself is rebuilt
      // from persisted normalized activities, never from these discovery edges.
      parseEvidence(tx,ownerAddress);
    }
  }
  if (!candidates.size) return 0;
  const link=db.prepare("INSERT OR IGNORE INTO chain_seed_file_sources(file_path,category,kind,address) VALUES(?,?,?,?)");
  return db.transaction(()=>{
    let count=0;
    for(const [address,info] of candidates) {
      link.run("@"+ownerKind+":"+ownerAddress,"discovered","wallet",address);
      addScopeMember(db,scopeId,"wallet",address,info.priority,info.reason,ownerKind,ownerAddress);
      count++;
    }
    return count;
  })();
}
async function processOne(db, row, cfg, api) {
  const known = row.last_success_at ? new Set(db.prepare(
    "SELECT signature FROM chain_seed_events WHERE kind=? AND address=?"
    + " ORDER BY block_time DESC, observed_at DESC LIMIT 150"
  ).all(row.kind, row.address).map(r => r.signature)) : new Set();
  const requestOptions = cfg.requestHooks;
  const recent = await api.fetchEnrichedTxsForMintWithMeta(
    row.address,cfg.recentLimit,known,undefined,row.kind==="wallet",requestOptions
  );
  let events = [...recent.transactions];
  let backfillCursor = row.backfill_cursor;
  let forwardCursor = row.forward_cursor;
  let complete = Boolean(row.backfill_complete);
  let gap = Boolean(row.possible_gap);
  let budgetPaused = Boolean(recent.budgetExhausted);

  // A high-volume wallet may accumulate >recentLimit transactions during
  // downtime. Persist the forward catch-up cursor and drain it across runs.
  if (known.size && recent.truncated && !recent.reachedKnownHistory) {
    if (!forwardCursor) forwardCursor = recent.transactions.at(-1)?.signature || null;
    gap = true;
  }
  if (!budgetPaused && forwardCursor && known.size) {
    let bridge = null;
    try {
      bridge = await api.fetchEnrichedTxsForMintWithMeta(
        row.address,cfg.backfillLimit,known,forwardCursor,row.kind==="wallet",requestOptions
      );
    } catch(error) {
      if ((error && error.code)!=="HELIUS_BUDGET_EXCEEDED") throw error;
      budgetPaused = true;
    }
    if (bridge) {
      events.push(...bridge.transactions);
      budgetPaused = Boolean(bridge.budgetExhausted);
      if (bridge.reachedKnownHistory || bridge.exhausted) {
        forwardCursor = null;
        gap = false;
      } else {
        const next = bridge.transactions.at(-1)?.signature;
        if (!next || next === forwardCursor) {
          if (!budgetPaused) throw new Error("Catch-up cursor did not advance");
        } else forwardCursor = next;
      }
    }
  }

  if (!budgetPaused && !complete && !backfillCursor) {
    backfillCursor = recent.transactions.at(-1)?.signature || null;
    if (recent.exhausted) complete = true;
  } else if (!budgetPaused && !complete && backfillCursor) {
    let historical = null;
    try {
      historical = await api.fetchEnrichedTxsForMintWithMeta(
        row.address,cfg.backfillLimit,null,backfillCursor,row.kind==="wallet",requestOptions
      );
    } catch(error) {
      if ((error && error.code)!=="HELIUS_BUDGET_EXCEEDED") throw error;
      budgetPaused = true;
    }
    if (historical) {
      events.push(...historical.transactions);
      budgetPaused = Boolean(historical.budgetExhausted);
      if (historical.exhausted) complete = true;
      else {
        const next = historical.transactions.at(-1)?.signature;
        if (!next || next === backfillCursor) {
          if (!budgetPaused) throw new Error("Backfill made no cursor progress");
        } else backfillCursor = next;
      }
    }
  }
  // A partial page returned because the credit guard fired is committed with
  // its cursor. This avoids re-downloading pages already paid for on resume.
  if (budgetPaused && !complete && !backfillCursor && !forwardCursor) {
    backfillCursor = events.at(-1)?.signature || null;
  }

  const unique = [...new Map(events.filter(tx => tx && tx.signature)
    .map(tx => [tx.signature, tx])).values()];
  // Address history for a mint is not a complete token transfer/trade index.
  // Keep the coverage gap visible until a dedicated venue/transfer indexer is used.
  const trades = [];
  const cadence = row.priority >= 100 ? 5 * 60_000 :
    row.priority >= 90 ? 15 * 60_000 : row.priority >= 65 ? 6 * 3600_000 : 12 * 3600_000;
  if (row.kind === "token") gap = true;
  else if (complete && !forwardCursor && !budgetPaused) gap = false;

  const added = db.transaction(() => {
    const now = Date.now();
    const owned = db.prepare("SELECT 1 FROM chain_seed_targets WHERE kind=? AND address=? AND lease_token IS ? AND (lease_until IS NULL OR lease_until>?)")
      .get(row.kind,row.address,row.lease_token??null,now);
    if (!owned) throw new Error("Collector lease lost before commit: "+row.kind+":"+row.address);
    const n = persistEvents(db,row.kind,row.address,unique);
    if (row.kind === "wallet") {
      appendDiscovered(db,row.address,unique,cfg.scopeId||null);
      if (cfg.scopeId) appendDiscoveredWallets(db,"wallet",row.address,unique,cfg.scopeId);
    } else if (row.kind === "token" && cfg.scopeId) {
      appendDiscoveredWallets(db,"token",row.address,unique,cfg.scopeId);
    }
    if (row.kind === "dex_program") require("./blockchain-dex-index.cjs").indexProgramBatch(db,row.address,unique);
    const update=db.prepare(
      "UPDATE chain_seed_targets SET last_success_at=?,next_run_at=?,lease_until=NULL,lease_token=NULL,"
      + "attempts=0,last_error=NULL,backfill_cursor=?,forward_cursor=?,"
      + "backfill_complete=?,possible_gap=?,events_saved=events_saved+?"
      + " WHERE kind=? AND address=? AND lease_token IS ? AND (lease_until IS NULL OR lease_until>?)"
    ).run(now,now+(budgetPaused?0:(complete&&!forwardCursor?cadence:60_000)),
      backfillCursor,forwardCursor,complete?1:0,gap?1:0,n,
      row.kind,row.address,row.lease_token??null,now);
    if (update.changes!==1) throw new Error("Collector lease changed during commit");
    if (row.kind === "wallet") require("./blockchain-forensics.cjs").rebuildWallet(db,row.address);
    return n;
  })();
  return {kind:row.kind,address:row.address,newEvents:added,normalizedTrades:trades.length,
    complete,possibleGap:gap,budgetPaused};
}
function failTask(db, row, error) {
  const attempts = row.attempts + 1;
  const jitter = Math.floor(Math.random() * 500);
  const delay = Math.min(3_600_000, 10_000 * (2 ** Math.min(8, attempts))) + jitter;
  db.prepare(
    "UPDATE chain_seed_targets SET attempts=?,last_error=?,next_run_at=?,"
    + "lease_until=NULL,lease_token=NULL WHERE kind=? AND address=? AND lease_token IS ?"
  ).run(attempts, String(error && error.message || error).slice(0, 400),
    Date.now() + delay, row.kind, row.address, row.lease_token??null);
}

async function collect(db, args, scopeId = null) {
  const keys = require("../lib/trade/helius-rotation").getHeliusApiKeys();
  if (!keys.length) throw new Error("Valid HELIUS_API_KEY(S) required for --mode collect/pilot");
  const helius = require("../lib/trade/helius");
  const { persistTokenTrades, markTokenTradeChecked } = require("../lib/trade/db");
  const api = { ...helius, persistTokenTrades, markTokenTradeChecked };
  const startedAt = Date.now();
  const maxObjects = Math.min(args.limit,args.maxObjects);
  const runId = startCollectionRun(db,{...args,limit:maxObjects},scopeId);
  let claimed=0,succeeded=0,failed=0,inserted=0,gaps=0;
  let budgetPaused=false,stopReason=null;
  async function worker() {
    while (!stopRequested && !budgetPaused && claimed<maxObjects) {
      const row=claimOne(db,Boolean(args.scanMintAddresses || scopeId),scopeId);
      if (!row) break;
      claimed++;
      const taskCfg={...args,scopeId,requestHooks:requestHooksForTask(db,runId,row,args)};
      try {
        const result=await processOne(db,row,taskCfg,api);
        succeeded++;inserted+=result.newEvents;
        if(result.possibleGap)gaps++;
        if(result.budgetPaused) {
          budgetPaused=true;
          stopReason="Credit guard reached after a partial page was checkpointed";
        }
        if(succeeded%10===0) console.log(JSON.stringify({runId,progress:succeeded,inserted,failed,gaps,budgetPaused}));
      } catch(error) {
        if ((error && error.code)==="HELIUS_BUDGET_EXCEEDED") {
          budgetPaused=true;
          stopReason=String(error.message||error);
          releaseTaskForBudget(db,row);
          break;
        }
        failed++;
        failTask(db,row,error);
        console.error("[blockchain-collector]",row.kind,row.address,
          error instanceof Error?error.message:String(error));
      }
    }
  }
  try {
    await Promise.all(Array.from({length:args.concurrency},worker));
  } catch(error) {
    finishCollectionRun(db,runId,"failed",String(error&&error.message||error));
    throw error;
  }
  const durationSec=Math.max(0.001,(Date.now()-startedAt)/1000);
  const runStatus=budgetPaused?"budget_paused":stopRequested?"stopped":failed>0&&succeeded===0?"failed":"completed";
  finishCollectionRun(db,runId,runStatus,stopReason);
  const runUsage=db.prepare(
    "SELECT COALESCE(SUM(COALESCE(actual_credits,estimated_credits)),0) AS used,COUNT(*) AS requests,"+
    "SUM(CASE WHEN actual_credits IS NOT NULL THEN 1 ELSE 0 END) AS reported "+
    "FROM chain_helius_usage_requests WHERE run_id=?"
  ).get(runId);
  return {
    runId,scopeId,status:runStatus,claimed,succeeded,failed,newEvents:inserted,possibleGaps:gaps,
    durationSec:Number(durationSec.toFixed(2)),
    targetsPerSecond:Number((succeeded/durationSec).toFixed(2)),
    eventsPerSecond:Number((inserted/durationSec).toFixed(2)),
    credits:{estimatedOrReported:runUsage.used,requests:runUsage.requests,
      providerReportedRequests:runUsage.reported||0,runBudgetCredits:args.runBudgetCredits,
      monthly:usageStatus(db,args)},
    budgetPaused,stoppedReason:stopReason,stopped:stopRequested,
  };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!["import", "collect", "all", "watch", "pilot", "status"].includes(args.mode)) throw new Error("Unknown --mode: " + args.mode);
  // In read-only mode no database is opened or changed.
  if (args.dryRun) {
    if (!["import", "all"].includes(args.mode)) throw new Error("--dry-run requires import/all");
    return console.log(JSON.stringify(importFolders(null, args), null, 2));
  }
  // Status is strictly read-only. Opening through getDb() would initialize
  // schemas and sync configured programs, unexpectedly mutating the database.
  if (args.mode === "status") {
    const file=path.resolve(process.env.SOLANA_TRADE_DB_PATH?.trim() || path.join(process.cwd(),"data","trade.db"));
    if (!fs.existsSync(file)) return console.log(JSON.stringify({status:"not_initialized"},null,2));
    const Database=require("better-sqlite3");
    const readonly=new Database(file,{readonly:true,fileMustExist:true});
    try {
      const exists=readonly.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_seed_targets'").get();
      return console.log(JSON.stringify({status:exists?status(readonly,args):"not_initialized"},null,2));
    } finally {readonly.close();}
  }
  require("ts-node").register({
    skipProject: true, transpileOnly: true,
    compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true },
  });
  const db = require("../lib/trade/db").getDb();
  initDb(db);
  resolveBudgetSettings(db,args,["collect","pilot","watch","all"].includes(args.mode));
  const scopeId = args.seedToken ? ensurePilotScope(db,args.seedToken) : null;
  if (!scopeId) syncDexProgramSources(db);
  if (args.mode === "watch") {
    while (!stopRequested) {
      try {
        const imported = scopeId ? null : importFolders(db, args);
        const collected = await collect(db, args, scopeId);
        console.log(JSON.stringify({ watchCycle: new Date().toISOString(), imported, collected, status: status(db,args) }));
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
  if (args.mode === "pilot" || args.mode === "collect" || args.mode === "all") {
    console.log(JSON.stringify({ collection: await collect(db,args,scopeId) },null,2));
  }
  console.log(JSON.stringify({ status: status(db,args) },null,2));
}
if (require.main === module) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
module.exports = {
  parseArgs,resolveBudgetSettings,initDb,appendDiscovered,appendDiscoveredWallets,persistEvents,processOne,claimOne,
  syncDexProgramSources,ensurePilotScope,addScopeMember,startCollectionRun,reserveHeliusCredits,
  recordHeliusResponse,recordHeliusError,releaseTaskForBudget,finishCollectionRun,usageStatus,currentMonthKey,
};
