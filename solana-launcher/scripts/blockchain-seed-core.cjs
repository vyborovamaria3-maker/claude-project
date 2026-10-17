"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEADERS = {
  token: new Set([
    "mint", "tokenmint", "tokenaddress", "basetokenaddress", "baseaddress",
    "contractaddress", "contract", "tokencontract", "ca", "адрестокена",
    "адресконтракта", "контракт", "токенадрес", "адресмонеты",
  ]),
  wallet: new Set([
    "wallet", "walletaddress", "trader", "traderaddress", "owner", "address",
    "адрескошелька", "кошелек", "кошелёк", "адрестрейдера", "walletid",
  ]),
};
const PRIORITIES = { dex_trending: 100, profitable_wallets: 90, migrated: 65, discovered: 40 };
const SOURCE_BITS = { dex_trending: 2, profitable_wallets: 4, migrated: 1, discovered: 8 };

function normalizeHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").toLowerCase()
    .replace(/[\s_\-\.\(\)\[\]#\/:]+/g, "").trim();
}

function isSolanaAddress(value) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return false;
  // Validate decoded length, not just the base58 alphabet.
  let n = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return false;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (n > 0n) { bytes++; n >>= 8n; }
  for (const character of value) {
    if (character !== "1") break;
    bytes++;
  }
  return bytes === 32;
}

function normalizeCell(cell) {
  const input = cell && (cell.w ?? cell.v);
  if (input === null || input === undefined) return "";
  const value = String(input).trim();
  return value.length <= 10000 ? value : value.slice(0, 10000);
}

function extractAddress(value) {
  const text = String(value ?? "").trim();
  if (isSolanaAddress(text)) return text;
  // A sheet can contain a Solscan token URL. Do not mistake a DexScreener
  // pair address for the actual mint (pairs are not token mints).
  const match = /^https?:\/\/(?:www\.)?solscan\.io\/(?:token|account)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#].*)?$/i.exec(text);
  return match && isSolanaAddress(match[1]) ? match[1] : null;
}

function toRowMap(sheet, maxRows = 100000) {
  const rows = new Map();
  for (const [ref, cell] of Object.entries(sheet || {})) {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(ref);
    if (!match) continue;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1 || number > maxRows) continue;
    const value = normalizeCell(cell);
    if (!value) continue;
    let row = rows.get(number);
    if (!row) { row = new Map(); rows.set(number, row); }
    row.set(match[1], value);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]);
}

function selectColumn(headers, kind) {
  const aliases = HEADERS[kind];
  for (const [column, value] of headers) {
    if (aliases.has(normalizeHeader(value))) return column;
  }
  return null;
}

function parseSheet(sheet, kind, maxRows = 100000) {
  const rows = toRowMap(sheet, maxRows);
  if (!rows.length) return { addresses: [], inspected: 0, skipped: 0, headerFound: false };
  let headerIndex = -1;
  let column = null;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    column = selectColumn(rows[i][1], kind);
    if (column) { headerIndex = i; break; }
  }
  const seen = new Set();
  let inspected = 0;
  let skipped = 0;
  const result = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const [, cells] = rows[i];
    inspected++;
    // Fallback is intentionally narrow. Never guess a mint from a multi-column
    // trending sheet with an unrecognized header: that might be a pair address.
    const value = column
      ? cells.get(column)
      : cells.size === 1 ? [...cells.values()][0] : "";
    const address = extractAddress(value);
    if (!address) { skipped++; continue; }
    if (seen.has(address)) continue;
    seen.add(address);
    result.push(address);
  }
  return { addresses: result, inspected, skipped, headerFound: headerIndex >= 0 };
}

function parseWorkbook(workbook, category, maxRows = 100000) {
  if (!PRIORITIES[category] || category === "discovered") throw new Error("Unsupported folder category");
  const kind = category === "profitable_wallets" ? "wallet" : "token";
  const addresses = new Set();
  const sheets = [];
  for (const name of workbook.SheetNames || []) {
    const result = parseSheet(workbook.Sheets[name], kind, maxRows);
    sheets.push({ name, inspected: result.inspected, matched: result.addresses.length,
      skipped: result.skipped, headerFound: result.headerFound });
    for (const address of result.addresses) addresses.add(address);
  }
  return { kind, category, addresses: [...addresses], sheets };
}

function scanFolder(root, limitFiles = 5000) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory()) throw new Error("Excel source must be a directory: " + root);
  const files = [];
  const dirs = [resolved];
  while (dirs.length) {
    const dir = dirs.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(name);
      if (entry.isFile() && /\.xlsx$/i.test(name) && !entry.name.startsWith("~$")) {
        if (files.length >= limitFiles) throw new Error("Too many XLSX files; raise --max-files intentionally");
        files.push(name);
      }
    }
  }
  return files.sort();
}

module.exports = {
  PRIORITIES, SOURCE_BITS, normalizeHeader, isSolanaAddress,
  parseSheet, parseWorkbook, scanFolder, extractAddress,
};
