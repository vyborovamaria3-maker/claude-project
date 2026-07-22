#!/usr/bin/env node
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = process.cwd();
const DB_PATH = path.join(PROJECT_ROOT, "data", "trade.db");
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const TRADE_COLUMNS = {
  mint: ["mint", "token_mint", "tokenMint", "base_mint", "baseMint", "currency_id", "currencyId", "token_address", "tokenAddress", "pair.currency.id", "pair.token.address"],
  signature: ["signature", "tx", "tx_hash", "txHash", "hash", "transaction_hash", "transactionHash", "transactionheader.hash"],
  timestamp: ["timestamp", "time", "block_time", "blockTime", "date", "datetime", "created_at", "createdAt", "block.timestamp", "block.time"],
  trader: ["trader", "wallet", "owner", "user", "user_address", "userAddress", "maker", "signer", "trader.address"],
  type: ["type", "side", "trade_type", "tradeType", "action", "side.type"],
  amountSol: ["amount_sol", "amountSol", "sol_amount", "solAmount", "quote_amount", "quoteAmount", "amounts.quote", "amounts_quote"],
  amountTokens: ["amount_tokens", "amountTokens", "token_amount", "tokenAmount", "base_amount", "baseAmount", "amounts.base", "amounts_base"],
  priceSol: ["price_sol", "priceSol", "price_native", "priceNative", "price"],
};

const TOKEN_COLUMNS = {
  mint: ["mint", "token_mint", "tokenMint", "address", "token_address", "tokenAddress", "id"],
  creator: ["creator", "dev", "deployer", "creator_address", "creatorAddress", "user", "userAddress", "owner"],
  symbol: ["symbol", "ticker"],
  name: ["name", "token_name", "tokenName"],
  createdAt: ["created_at", "createdAt", "timestamp", "creation_time", "creationTime", "block_time", "blockTime"],
  marketCapUsd: ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "usd_market_cap", "usdMarketCap"],
  athUsd: ["ath_usd", "athUsd", "ath", "all_time_high_usd", "allTimeHighUsd"],
  isMigrated: ["is_migrated", "isMigrated", "migrated", "graduated", "complete"],
  totalSupply: ["total_supply", "totalSupply", "supply"],
};

function printUsage() {
  console.log([
    "Usage:",
    "  npm run pumpfun:import -- --file <dataset.csv|json|jsonl> --kind trades|tokens [--source name] [--db data/trade.db]",
    "",
    "Examples:",
    "  npm run pumpfun:import -- --file ./data/pumpfun-trades.csv --kind trades --source bitquery",
    "  npm run pumpfun:import -- --file ./data/pumpfun-tokens.jsonl --kind tokens --source kaggle",
    "",
    "Supported input:",
    "  CSV with a header row, JSON array, JSONL/NDJSON with one object per line.",
    "",
    "For trades the importer needs: mint, signature/tx/hash, timestamp/time, trader/wallet, buy/sell side, SOL amount, token amount.",
    "For tokens the importer needs: mint and creator/dev/deployer. Other token metadata is optional.",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = { source: "external" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function normalizeKey(key) {
  return String(key).trim().replace(/^\uFEFF/, "").replace(/[\s-]+/g, "_").toLowerCase();
}

function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const raw = String(key).trim().replace(/^\uFEFF/, "");
    out[raw] = value;
    out[normalizeKey(raw)] = value;
  }
  return out;
}

function getValue(row, candidates) {
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, candidate)) return row[candidate];
    const normalized = normalizeKey(candidate);
    if (Object.prototype.hasOwnProperty.call(row, normalized)) return row[normalized];
  }
  return undefined;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).trim().replace(/,/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value) {
  const numeric = parseNumber(value);
  if (numeric !== null) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "migrated", "graduated", "complete", "completed"].includes(normalized);
}

function parseSide(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["buy", "b", "bid", "in"].includes(normalized)) return "buy";
  if (["sell", "s", "ask", "out"].includes(normalized)) return "sell";
  return null;
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [headers, ...dataRows] = rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
  if (!headers) return [];
  return dataRows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

function readRows(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return parseCsv(text);
  if (ext === ".jsonl" || ext === ".ndjson") {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  if (ext === ".json") {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    throw new Error("JSON input must be an array, or an object with data[]/rows[]");
  }
  throw new Error(`Unsupported file extension: ${ext}`);
}

function ensureDb(db) {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_trades (
      mint TEXT NOT NULL,
      signature TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      trader TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_sol REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      price_sol REAL NOT NULL,
      source TEXT,
      inserted_at INTEGER NOT NULL,
      PRIMARY KEY (mint, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_token_trades_mint_ts ON token_trades(mint, timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_trades_mint_trader ON token_trades(mint, trader);

    CREATE TABLE IF NOT EXISTS dev_tokens (
      mint TEXT NOT NULL,
      creator TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      image TEXT,
      description TEXT,
      twitter TEXT,
      telegram TEXT,
      website TEXT,
      created_at INTEGER,
      market_cap_usd REAL,
      ath_usd REAL,
      is_migrated INTEGER NOT NULL DEFAULT 0,
      reached_300k INTEGER NOT NULL DEFAULT 0,
      total_supply INTEGER,
      token_volume_sol REAL,
      token_volume_usd REAL,
      source TEXT NOT NULL DEFAULT 'pumpfun',
      last_updated_at INTEGER NOT NULL,
      PRIMARY KEY (mint, creator)
    );
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_creator ON dev_tokens(creator);
    CREATE INDEX IF NOT EXISTS idx_dev_tokens_created ON dev_tokens(created_at DESC);
  `);
}

function importTrades(db, rows, source) {
  const now = Date.now();
  const stmt = db.prepare(`INSERT INTO token_trades
    (mint, signature, timestamp, trader, type, amount_sol, amount_tokens, price_sol, source, inserted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, signature) DO UPDATE SET
      timestamp = excluded.timestamp,
      trader = excluded.trader,
      type = excluded.type,
      amount_sol = excluded.amount_sol,
      amount_tokens = excluded.amount_tokens,
      price_sol = excluded.price_sol,
      source = excluded.source`);

  let imported = 0;
  let skipped = 0;
  const run = db.transaction((items) => {
    for (const raw of items) {
      const row = normalizeRow(raw);
      const mint = String(getValue(row, TRADE_COLUMNS.mint) ?? "").trim();
      const signature = String(getValue(row, TRADE_COLUMNS.signature) ?? "").trim();
      const timestamp = parseTimestamp(getValue(row, TRADE_COLUMNS.timestamp));
      const trader = String(getValue(row, TRADE_COLUMNS.trader) ?? "").trim();
      const type = parseSide(getValue(row, TRADE_COLUMNS.type));
      const amountSol = parseNumber(getValue(row, TRADE_COLUMNS.amountSol));
      const amountTokens = parseNumber(getValue(row, TRADE_COLUMNS.amountTokens));
      const explicitPriceSol = parseNumber(getValue(row, TRADE_COLUMNS.priceSol));
      const priceSol = explicitPriceSol ?? (amountSol !== null && amountTokens ? amountSol / amountTokens : null);

      if (!BASE58_RE.test(mint) || !signature || timestamp === null || !BASE58_RE.test(trader) || !type || !amountSol || !amountTokens || !priceSol) {
        skipped += 1;
        continue;
      }

      stmt.run(mint, signature, timestamp, trader, type, amountSol, amountTokens, priceSol, source, now);
      imported += 1;
    }
  });
  run(rows);
  return { imported, skipped };
}

function importTokens(db, rows, source) {
  const now = Date.now();
  const stmt = db.prepare(`INSERT INTO dev_tokens
    (mint, creator, symbol, name, image, description, twitter, telegram, website,
     created_at, market_cap_usd, ath_usd, is_migrated, reached_300k, total_supply, source, last_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, creator) DO UPDATE SET
      symbol = COALESCE(excluded.symbol, symbol),
      name = COALESCE(excluded.name, name),
      created_at = COALESCE(excluded.created_at, created_at),
      market_cap_usd = COALESCE(excluded.market_cap_usd, market_cap_usd),
      ath_usd = MAX(COALESCE(excluded.ath_usd, 0), COALESCE(ath_usd, 0)),
      is_migrated = excluded.is_migrated,
      reached_300k = excluded.reached_300k,
      total_supply = COALESCE(excluded.total_supply, total_supply),
      source = excluded.source,
      last_updated_at = excluded.last_updated_at`);

  let imported = 0;
  let skipped = 0;
  const run = db.transaction((items) => {
    for (const raw of items) {
      const row = normalizeRow(raw);
      const mint = String(getValue(row, TOKEN_COLUMNS.mint) ?? "").trim();
      const creator = String(getValue(row, TOKEN_COLUMNS.creator) ?? "").trim();
      if (!BASE58_RE.test(mint) || !BASE58_RE.test(creator)) {
        skipped += 1;
        continue;
      }

      const symbol = String(getValue(row, TOKEN_COLUMNS.symbol) ?? "").trim() || null;
      const name = String(getValue(row, TOKEN_COLUMNS.name) ?? "").trim() || null;
      const createdAt = parseTimestamp(getValue(row, TOKEN_COLUMNS.createdAt));
      const marketCapUsd = parseNumber(getValue(row, TOKEN_COLUMNS.marketCapUsd));
      const athUsd = parseNumber(getValue(row, TOKEN_COLUMNS.athUsd));
      const isMigrated = parseBool(getValue(row, TOKEN_COLUMNS.isMigrated));
      const totalSupply = parseNumber(getValue(row, TOKEN_COLUMNS.totalSupply));

      stmt.run(mint, creator, symbol, name, null, null, null, null, null, createdAt, marketCapUsd, athUsd, isMigrated ? 1 : 0, athUsd !== null && athUsd >= 300_000 ? 1 : 0, totalSupply, source, now);
      imported += 1;
    }
  });
  run(rows);
  return { imported, skipped };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

if (!args.file || !args.kind || !["trades", "tokens"].includes(args.kind)) {
  printUsage();
  process.exit(1);
}

const inputPath = path.resolve(PROJECT_ROOT, String(args.file));
if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

const dbPath = path.resolve(PROJECT_ROOT, String(args.db || DB_PATH));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const rows = readRows(inputPath);
const db = new Database(dbPath);
ensureDb(db);

const result = args.kind === "trades"
  ? importTrades(db, rows, String(args.source || "external"))
  : importTokens(db, rows, String(args.source || "external"));

db.close();
console.log(JSON.stringify({ kind: args.kind, file: inputPath, db: dbPath, totalRows: rows.length, ...result }, null, 2));
