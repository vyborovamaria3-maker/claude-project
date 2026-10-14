#!/usr/bin/env node
"use strict";
// End-to-end import validation: real guarded XLSX decoder + better-sqlite3,
// using temporary files only. Does not contact Helius or touch the app database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");
const script = path.join(__dirname, "blockchain-seed-collector.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockchain-xlsx-int-"));
const TOK_A = "So11111111111111111111111111111111111111112";
const TOK_B = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WALLET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const py = [
  "import json, sys, zipfile",
  "from xml.sax.saxutils import escape",
  "target, data = sys.argv[1], json.loads(sys.argv[2])",
  "main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'",
  "rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'",
  "pkg = 'http://schemas.openxmlformats.org/package/2006/relationships'",
  "sheets = []",
  "for row_i, row in enumerate(data, 1):",
  "  cells = []",
  "  for col_i, value in enumerate(row):",
  "    col = chr(ord('A') + col_i)",
  "    cells.append('<c r=\"%s%d\" t=\"inlineStr\"><is><t>%s</t></is></c>' % (col,row_i,escape(str(value))))",
  "  sheets.append('<row r=\"%d\">%s</row>' % (row_i,''.join(cells)))",
  "with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as z:",
  "  z.writestr('xl/workbook.xml','<workbook xmlns=\"%s\" xmlns:r=\"%s\"><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>' % (main,rel))",
  "  z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns=\"%s\"><Relationship Id=\"rId1\" Type=\"%s/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>' % (pkg,rel))",
  "  z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns=\"%s\"><sheetData>%s</sheetData></worksheet>' % (main,''.join(sheets)))",
  "  z.writestr('[Content_Types].xml','<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>')",
].join("\n");

const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
function workbook(file, rows) {
  execFileSync(python, ["-c", py, file, JSON.stringify(rows)], { stdio: "pipe" });
}
function run(mode, folders) {
  const out = execFileSync(process.execPath, [
    script, "--mode", mode,
    "--migrated-dir", folders.migrated,
    "--trending-dir", folders.trending,
    "--wallets-dir", folders.wallets,
  ], { cwd: root, stdio: "pipe", encoding: "utf8", timeout: 30000 });
  return out;
}

try {
  const folders = {
    migrated: path.join(root, "migrated"),
    trending: path.join(root, "trending"),
    wallets: path.join(root, "wallets"),
  };
  for (const folder of Object.values(folders)) fs.mkdirSync(folder);
  workbook(path.join(folders.migrated, "migrated.xlsx"), [
    ["Token Address", "Ticker"], [TOK_A, "SOL"] ]);
  workbook(path.join(folders.trending, "trending.xlsx"), [
    ["Pair Address", "Mint", "Volume"], [WALLET, TOK_A, "1000"],
    [WALLET, TOK_B, "2000"] ]);
  workbook(path.join(folders.wallets, "profitable.xlsx"), [
    ["Wallet", "PnL"], [WALLET, "10000"] ]);

  const dry = run("import", folders);
  // Non-network import is idempotent and category-specific.
  const first = JSON.parse(run("import", folders).match(/"import":\s*(\{[\s\S]*?\})\s*,\s*"status"/)?.[1] || "null");
  // Full CLI emits two JSON documents; checking SQLite is the authoritative test.
  const dbPath = path.join(root, "data", "trade.db");
  assert(fs.existsSync(dbPath));
  const db = new Database(dbPath);
  try {
    const files = db.prepare("SELECT COUNT(*) AS c FROM chain_seed_files").get().c;
    assert.equal(files, 3);
    const targets = db.prepare("SELECT kind,address,priority,source_mask FROM chain_seed_targets ORDER BY kind,address").all();
    assert.equal(targets.length, 3);
    const tokenA = targets.find(row => row.kind === "token" && row.address === TOK_A);
    assert.equal(tokenA.priority, 100);
    assert.equal(tokenA.source_mask, 3, "overlapping categories must be OR-ed");
    const tokenB = targets.find(row => row.kind === "token" && row.address === TOK_B);
    assert.equal(tokenB.priority, 100);
    const wallet = targets.find(row => row.kind === "wallet" && row.address === WALLET);
    assert.equal(wallet.priority, 90);
    assert.equal(wallet.source_mask, 4);
  } finally {
    db.close();
  }
  const output = run("import", folders);
  assert.match(output, /"unchangedFiles": 3/);
  assert.match(output, /"changedFiles": 0/);
  assert.match(dry, /"scannedFiles": 3/);
  console.log("[blockchain-seed-integration] OK: safe XLSX -> SQLite, categories, dedup, priorities, incremental reimport");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
