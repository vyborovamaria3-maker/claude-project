#!/usr/bin/env node
import Database from "better-sqlite3";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED = new Set(["db", "output", "from", "to", "limit"]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new TypeError("invalid_arguments");
    const equals = item.indexOf("=");
    const key = equals >= 0 ? item.slice(2, equals) : item.slice(2);
    const value = equals >= 0 ? item.slice(equals + 1) : argv[++index];
    if (!ALLOWED.has(key) || typeof value !== "string" || !value || Object.hasOwn(args, key)) {
      throw new TypeError("invalid_arguments");
    }
    args[key] = value;
  }
  for (const key of ["from", "to"]) {
    if (args[key] && !/^\d{4}-\d{2}-\d{2}$/.test(args[key])) throw new TypeError("invalid_" + key);
    if (args[key] && new Date(args[key] + "T00:00:00.000Z").toISOString().slice(0, 10) !== args[key]) {
      throw new TypeError("invalid_" + key);
    }
  }
  if (args.from && args.to && args.from > args.to) throw new TypeError("invalid_date_range");
  const limit = Number(args.limit ?? "100000");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new TypeError("invalid_limit");
  return {
    db: resolve(args.db ?? process.env.SOLANA_TRADE_DB_PATH?.trim() ?? path.join("data", "trade.db")),
    output: args.output ? resolve(args.output) : null,
    from: args.from ?? null,
    to: args.to ?? null,
    limit,
  };
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='fomo_score_snapshots'",
    ).get();
    if (!table) throw new Error("fomo_snapshot_schema_missing");

    const clauses = [];
    const params = [];
    if (args.from) {
      clauses.push("signal_at >= ?");
      params.push(Date.parse(args.from + "T00:00:00.000Z"));
    }
    if (args.to) {
      clauses.push("signal_at < ?");
      params.push(Date.parse(args.to + "T00:00:00.000Z") + 24 * 60 * 60 * 1000);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = db.prepare(
      `SELECT * FROM fomo_score_snapshots ${where} ORDER BY signal_at,canonical_token_id LIMIT ?`,
    ).all(...params, args.limit);

    const output = rows.map((row) => JSON.stringify({
      canonicalTokenId: row.canonical_token_id,
      mint: row.mint,
      signalAt: iso(row.signal_at),
      maxInputObservedAt: iso(row.max_input_observed_at),
      scoreVersion: row.score_version,
      fomoPressure: row.fomo_pressure,
      fomoQuality: row.fomo_quality,
      qualityCoverage: row.quality_coverage,
      signalCoverage: {
        x: row.x_coverage,
        tg: row.tg_coverage,
        knownAt: iso(row.source_coverage_known_at),
      },
      sourceMeta: JSON.parse(row.source_meta_json),
      captureConfig: JSON.parse(row.capture_config_json),
      snapshotId: row.snapshot_id,
      xInputSha256: row.x_input_sha256,
      tgInputSha256: row.tg_input_sha256,
      inputSha256: row.input_sha256,
      snapshotSha256: row.snapshot_sha256,
      outcomeAt: null,
      outcomeObservedAt: null,
      outcomeEvidenceRef: null,
      forwardReturnPct: null,
      maxDrawdownPct: null,
      outcomeCoverage: { price: "unknown", knownAt: null },
    })).join("\n") + (rows.length ? "\n" : "");

    if (args.output) await writeFile(args.output, output, "utf8");
    else process.stdout.write(output);
    process.stderr.write("exported_snapshots=" + rows.length + "\n");
  } finally {
    db.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "fomo_snapshot_export_failed";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
}
