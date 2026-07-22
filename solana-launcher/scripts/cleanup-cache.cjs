#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const cwd = process.cwd();
const dataDir = path.join(cwd, "data");
const dbPath = path.join(dataDir, "trade.db");
const nextCacheDir = path.join(cwd, ".next", "cache");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));

function getFlagValue(name, fallback = null) {
  const prefix = `${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return flags.has(name);
}

const dryRun = !hasFlag("--apply");
const vacuum = hasFlag("--vacuum");
const clearNextCache = hasFlag("--next-cache") || hasFlag("--all");
const busyTimeoutMs = Number(getFlagValue("--busy-timeout", "5000")) || 5000;

const tasks = [
  {
    name: "analysis_cache",
    countSql: `SELECT COUNT(*) AS count FROM analysis_cache WHERE fetched_at + ttl_ms < ?`,
    deleteSql: `DELETE FROM analysis_cache WHERE fetched_at + ttl_ms < ?`,
    description: "старые TTL-записи анализа",
  },
  {
    name: "wallet_profile_cache",
    countSql: `SELECT COUNT(*) AS count FROM wallet_profile_cache WHERE fetched_at + ttl_ms < ?`,
    deleteSql: `DELETE FROM wallet_profile_cache WHERE fetched_at + ttl_ms < ?`,
    description: "старые TTL-записи профилей кошельков",
  },
  {
    name: "dev_tokens_cache",
    countSql: `SELECT COUNT(*) AS count FROM dev_tokens_cache WHERE fetched_at + ttl_ms < ?`,
    deleteSql: `DELETE FROM dev_tokens_cache WHERE fetched_at + ttl_ms < ?`,
    description: "старые TTL-записи dev-токенов",
  },
];

function formatCount(value) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function removeDirSafe(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const before = fs.statSync(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  return before.isDirectory() ? 1 : 0;
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[cleanup-cache] DB not found: ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const now = Date.now();
  const report = [];

  for (const task of tasks) {
    const staleCount = db.prepare(task.countSql).get(now)?.count ?? 0;
    let removed = 0;

    if (!dryRun && staleCount > 0) {
      removed = db.prepare(task.deleteSql).run(now).changes;
    }

    report.push({
      table: task.name,
      description: task.description,
      stale: staleCount,
      removed,
    });
  }

  let nextCacheRemoved = 0;
  if (clearNextCache) {
    if (dryRun) {
      nextCacheRemoved = fs.existsSync(nextCacheDir) ? 1 : 0;
    } else {
      nextCacheRemoved = removeDirSafe(nextCacheDir);
    }
  }

  if (!dryRun) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      console.warn(`[cleanup-cache] WAL checkpoint skipped: ${error.message}`);
    }

    if (vacuum) {
      try {
        db.exec("VACUUM");
      } catch (error) {
        console.warn(`[cleanup-cache] VACUUM skipped: ${error.message}`);
      }
    }
  }

  const totalStale = report.reduce((sum, row) => sum + row.stale, 0);
  const totalRemoved = report.reduce((sum, row) => sum + row.removed, 0);

  console.log(`\n[cleanup-cache] mode: ${dryRun ? "dry-run" : "apply"}`);
  console.table(report.map((row) => ({
    table: row.table,
    stale_rows: formatCount(row.stale),
    removed_rows: formatCount(row.removed),
  })));

  if (clearNextCache) {
    console.log(`[cleanup-cache] .next/cache ${dryRun ? (nextCacheRemoved ? "would be removed" : "not found") : (nextCacheRemoved ? "removed" : "not found")}`);
  }

  console.log(`[cleanup-cache] stale rows found: ${formatCount(totalStale)}`);
  console.log(`[cleanup-cache] rows removed: ${formatCount(totalRemoved)}`);
  console.log(`[cleanup-cache] db path: ${dbPath}`);

  db.close();
}

try {
  main();
} catch (error) {
  console.error("[cleanup-cache] failed:", error);
  process.exitCode = 1;
}
