import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import * as XLSX from "xlsx";
import {
  getCreatorForMint,
} from "../lib/trade/dev";
import {
  getDb,
  persistDevWallet,
  persistDevTokens,
  persistMigrationTokenRows,
  persistMigrationWalletRows,
  persistMigrationXlsxFile,
  type DevTokenRow,
  type MigrationWorkbookKind,
  type MigrationTokenRow,
  type MigrationWalletRow,
} from "../lib/trade/db";

const PROJECT_ROOT = process.cwd();
const DEFAULT_INPUT_DIR = "C:\\Users\\Рафаил\\Desktop\\База данных";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_HEADER_ALIASES = {
  tokenAddress: ["tokenaddress", "token_address", "mint", "address"],
  ticker: ["ticker", "symbol"],
  totalUniqueBuyers: ["totaluniquebuyers", "uniquebuyers", "buyers"],
  currentMc: ["currentmc", "currentmarketcap", "marketcap", "marketcapusd"],
  marketCapMax: ["marketcapmax", "maxmarketcap", "ath", "athusd"],
  mintTimeText: ["minttime", "mintedat", "createdat"],
  migrationTimeText: ["migrationtime", "migratedat"],
  timeBeforeMigrationText: ["timebeforemigration", "timebeforemigration", "lifespan"],
} as const;
const WALLET_HEADER_ALIASES = {
  wallet: ["wallet", "address"],
  wr: ["wr", "winrate"],
  roi: ["roi"],
  pnl: ["pnl"],
  rockets: ["rockets"],
  medianRoi: ["medianroi"],
  avgRoi: ["avgroi"],
  fastTrades: ["fasttrades"],
  fastTradesPct: ["fasttradespct", "fasttradespercent", "fasttrades%"],
  balance: ["balance"],
  totalTokens: ["totaltokens"],
  soldGtBought: ["soldbought", "soldgtbought"],
  soldGtBoughtPct: ["soldboughtpct", "soldgtboughtpct"],
  avgTradeDurationText: ["avgtradeduration"],
  pfTokens: ["pftokens"],
  pfTradesPct: ["pftradespct", "pftradespercent"],
  avgBuySol: ["avgbuysol"],
  medianSolBuy: ["mediansolbuy"],
  avgMcapFirstTx: ["avgmcapfirsttx"],
  avgMcapLastTx: ["avgmcaplasttx"],
  lastTradeText: ["lasttrade"],
  migratedTokens: ["migratedtokens"],
  migratedPct: ["migratedpct"],
} as const;

type ParsedCell = { ref: string; value: string | number | boolean | null };
type ParsedRow = { index: number; cells: ParsedCell[] };
type ParsedSheet = { name: string; rows: ParsedRow[] };
type ParsedWorkbook = { fileName: string; sheets: ParsedSheet[] };

type ParsedArgs = {
  dir: string;
  file?: string;
  resolveCreators: boolean;
  resolveLimit: number;
  maxFiles: number | null;
};

type CanonicalRecord = {
  raw: Record<string, string>;
  exact: Map<string, string>;
  normalized: Record<string, string>;
};

type TokenSummary = {
  rows: number;
  uniqueTokens: number;
  migratedTokens: number;
  withCreator: number;
  avgTimeBeforeMigrationSeconds: number | null;
  minTimeBeforeMigrationSeconds: number | null;
  maxTimeBeforeMigrationSeconds: number | null;
  topByMarketCap: Array<{ tokenAddress: string; ticker: string | null; marketCapMax: number | null }>;
  topByCurrentMc: Array<{ tokenAddress: string; ticker: string | null; currentMc: number | null }>;
  mintHourHistogram: Array<{ hour: number; count: number }>;
  migrationHourHistogram: Array<{ hour: number; count: number }>;
};

type WalletSummary = {
  rows: number;
  uniqueWallets: number;
  topPnl: Array<{ wallet: string; pnl: number | null; roi: number | null }>;
  worstPnl: Array<{ wallet: string; pnl: number | null; roi: number | null }>;
  topRoi: Array<{ wallet: string; pnl: number | null; roi: number | null }>;
  worstRoi: Array<{ wallet: string; pnl: number | null; roi: number | null }>;
  lastTradeHourHistogram: Array<{ hour: number; count: number }>;
};

function printUsage() {
  console.log([
    "Usage:",
    "  npm run migrations:import -- --dir <folder> [--resolve-creators] [--resolve-limit 250] [--max-files 20]",
    "  npm run migrations:import -- --file <xlsx-file> [--resolve-creators] [--resolve-limit 250]",
    "",
    "Defaults:",
    `  --dir ${DEFAULT_INPUT_DIR}`,
    "",
    "What it does:",
    "  - Parses token-level and wallet-level XLSX reports.",
    "  - Saves raw rows and file summaries to SQLite.",
    "  - Optionally resolves creators for token rows and refreshes dev_wallets/dev_tokens.",
  ].join("\n"));
}

/**
 * Sanitize path to prevent path traversal attacks
 * Ensures the resolved path stays within the project root or the Desktop data folder
 */
function sanitizePath(inputPath: string): string {
  // Resolve to absolute path
  const resolved = path.resolve(inputPath);
  
  // Ensure path is within project root or is the default directory
  const projectRoot = path.resolve(PROJECT_ROOT);
  const defaultDir = path.resolve(DEFAULT_INPUT_DIR);
  
  const desktopBase = path.resolve("C:\\Users\\Рафаил\\Desktop\\База данных");

  // Allow paths within project root or the Desktop data folder
  if (resolved.startsWith(projectRoot) || resolved.startsWith(defaultDir) || resolved.startsWith(desktopBase)) {
    return resolved;
  }
  
  // Reject paths trying to escape to parent directories (../..)
  throw new Error(`Path traversal detected: ${inputPath} resolves outside allowed directories`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    dir: DEFAULT_INPUT_DIR,
    resolveCreators: false,
    resolveLimit: 250,
    maxFiles: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.dir = "";
      continue;
    }
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");

    if (key === "resolve-creators") {
      args.resolveCreators = true;
      continue;
    }

    if (key === "dir" && hasValue) {
      try {
        args.dir = sanitizePath(next);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      i += 1;
      continue;
    }

    if (key === "file" && hasValue) {
      try {
        args.file = sanitizePath(next);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      i += 1;
      continue;
    }

    if (key === "resolve-limit" && hasValue) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) args.resolveLimit = parsed;
      i += 1;
      continue;
    }

    if (key === "max-files" && hasValue) {
      const parsed = Number(next);
      args.maxFiles = Number.isFinite(parsed) ? parsed : null;
      i += 1;
      continue;
    }
  }

  return args;
}

function normalizeHeaderName(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\uFEFF/g, "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .toLowerCase();
}

function parseHumanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim().replace(/,/g, "");
  if (!raw) return null;

  const sign = raw.startsWith("-") ? -1 : 1;
  const cleaned = raw.replace(/^[-+]/, "").replace(/[$%]/g, "");
  const suffix = cleaned.slice(-1).toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  const numeric = suffix === "k" || suffix === "m" || suffix === "b" ? cleaned.slice(0, -1) : cleaned;
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? sign * parsed * multiplier : null;
}

function parseInteger(value: unknown): number | null {
  const parsed = parseHumanNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function parseDurationSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const hhmmss = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hhmmss) {
    return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3]);
  }
  const minuteMatch = raw.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  if (minuteMatch) return Math.round(Number(minuteMatch[1]) * 60);
  const hourMatch = raw.match(/(\d+(?:\.\d+)?)\s*hours?/);
  if (hourMatch) return Math.round(Number(hourMatch[1]) * 3600);
  const secondMatch = raw.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  if (secondMatch) return Math.round(Number(secondMatch[1]));
  return null;
}

function extractHour(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const direct = raw.match(/\b(\d{2}):(\d{2}):(\d{2})\b/);
  if (direct) return Number(direct[1]);
  const dt = new Date(raw);
  if (Number.isFinite(dt.getTime())) return dt.getHours();
  return null;
}

function parseWorkbookDate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const raw = String(value).trim();
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return Math.floor(direct / 1000);

  const textMatch = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:,)?\s+(\d{2}:\d{2}:\d{2})$/);
  if (textMatch) {
    const year = new Date().getFullYear();
    const parsed = Date.parse(`${textMatch[1]} ${textMatch[2]} ${year} ${textMatch[3]}`);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }

  return null;
}

function columnFromRef(ref: string): string {
  const match = String(ref).match(/^[A-Z]+/i);
  return match ? match[0].toUpperCase() : ref.toUpperCase();
}

function buildCanonicalRecord(row: ParsedRow, headerByColumn: Map<string, string>): CanonicalRecord {
  const raw: Record<string, string> = {};
  const exact = new Map<string, string>();
  const normalized: Record<string, string> = {};

  for (const cell of row.cells) {
    const column = columnFromRef(cell.ref);
    const header = headerByColumn.get(column);
    if (!header) continue;
    const text = cell.value === null || cell.value === undefined ? "" : String(cell.value).trim();
    raw[header] = text;
    exact.set(header, text);
    normalized[normalizeHeaderName(header)] = text;
  }

  return { raw, exact, normalized };
}

function getByExactHeader(record: CanonicalRecord, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const value = record.exact.get(candidate);
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}

function getByAliases(record: CanonicalRecord, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = record.normalized[alias];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}

function detectSheetKind(headers: string[]): MigrationWorkbookKind {
  const normalized = new Set(headers.map(normalizeHeaderName));
  const isToken = normalized.has("tokenaddress") && normalized.has("ticker") && normalized.has("timebeforemigration");
  const isWallet = normalized.has("wallet") && normalized.has("pnl") && normalized.has("roi");

  if (isToken && isWallet) return "mixed";
  if (isToken) return "token_report";
  if (isWallet) return "wallet_report";
  return "unknown";
}

function listXlsxFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      if (current.toLowerCase().endsWith(".xlsx")) files.push(current);
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      stack.push(path.join(current, entry.name));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function extractWorkbook(filePath: string): ParsedWorkbook {
  const wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false, cellText: true, raw: false });
  const sheets: ParsedSheet[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const rowsMap = new Map<number, ParsedCell[]>();
    for (let R = range.s.r; R <= range.e.r; R += 1) {
      const cells: ParsedCell[] = [];
      for (let C = range.s.c; C <= range.e.c; C += 1) {
        const ref = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = (ws as Record<string, XLSX.CellObject>)[ref];
        if (!cell) continue;
        let value: string | number | boolean | null = null;
        const formatted = (cell as { w?: string }).w;
        if (formatted !== undefined && formatted !== null && formatted !== "") {
          value = formatted;
        } else if (cell.v !== undefined && cell.v !== null) {
          if (cell.v instanceof Date) value = cell.v.toISOString();
          else value = cell.v as string | number | boolean;
        }
        if (value === null) continue;
        cells.push({ ref, value });
      }
      if (cells.length > 0) rowsMap.set(R + 1, cells);
    }
    const rows: ParsedRow[] = [...rowsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, cells]) => ({ index, cells }));
    sheets.push({ name: sheetName, rows });
  }
  return { fileName: path.basename(filePath), sheets };
}

function extractWorkbookViaPowerShell(filePath: string): ParsedWorkbook {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "migration-xlsx-"));
  const scriptPath = path.join(tempRoot, "extract-xlsx.ps1");
  const psScript = `
param([string]$FilePath)
$ErrorActionPreference = 'Stop'
$tmp = Join-Path $env:TEMP ('xlsx_' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'book.zip'
  Copy-Item -LiteralPath $FilePath -Destination $zip -Force
  $out = Join-Path $tmp 'unzipped'
  New-Item -ItemType Directory -Path $out | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $out -Force

  [xml]$workbook = Get-Content -LiteralPath (Join-Path $out 'xl/workbook.xml') -Raw
  [xml]$rels = Get-Content -LiteralPath (Join-Path $out 'xl/_rels/workbook.xml.rels') -Raw
  $ns = New-Object System.Xml.XmlNamespaceManager($workbook.NameTable)
  $ns.AddNamespace('a', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $ns.AddNamespace('pr', 'http://schemas.openxmlformats.org/package/2006/relationships')

  $shared = @()
  $sharedPath = Join-Path $out 'xl/sharedStrings.xml'
  if (Test-Path $sharedPath) {
    [xml]$sharedDoc = Get-Content -LiteralPath $sharedPath -Raw
    foreach ($si in $sharedDoc.SelectNodes('//a:si', $ns)) {
      $shared += $si.InnerText
    }
  }

  $sheetNodes = $workbook.SelectNodes('//a:sheets/a:sheet', $ns)
  $firstSheet = if ($sheetNodes.Count -gt 0) { $sheetNodes.Item(0) } else { $null }

  function Resolve-Cell([System.Xml.XmlElement]$cell) {
    $type = $cell.GetAttribute('t')
    $valueNode = $cell.SelectSingleNode('a:v', $ns)
    if ($type -eq 's' -and $valueNode) {
      return $shared[[int]$valueNode.InnerText]
    }
    if ($type -eq 'inlineStr') {
      return $cell.InnerText
    }
    if ($type -eq 'b' -and $valueNode) {
      return $valueNode.InnerText
    }
    if ($valueNode) {
      return $valueNode.InnerText
    }
    return $cell.InnerText
  }

  $sheets = @()
  foreach ($sheet in @($firstSheet)) {
    if (-not $sheet) { continue }
    $rid = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $rel = $rels.SelectSingleNode("//pr:Relationship[@Id='$rid']", $ns)
    if (-not $rel) { continue }
    $target = $rel.Target.TrimStart('/')
    $sheetPath = Join-Path $out ('xl/' + $target)
    [xml]$sheetXml = Get-Content -LiteralPath $sheetPath -Raw
    $rows = @()
    foreach ($row in $sheetXml.SelectNodes('//a:sheetData/a:row', $ns)) {
      $cells = @()
      foreach ($cell in $row.SelectNodes('a:c', $ns)) {
        $cells += [pscustomobject]@{
          ref = $cell.GetAttribute('r')
          value = (Resolve-Cell $cell)
        }
      }
      $rows += [pscustomobject]@{
        index = [int]$row.GetAttribute('r')
        cells = $cells
      }
    }
    $sheets += [pscustomobject]@{
      name = [string]$sheet.name
      rows = $rows
    }
  }

  [pscustomobject]@{
    fileName = [System.IO.Path]::GetFileName($FilePath)
    sheets = $sheets
  } | ConvertTo-Json -Depth 20 -Compress
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  fs.writeFileSync(scriptPath, psScript, "utf8");

  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, filePath],
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout.trim()) as ParsedWorkbook;
    return parsed;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function rowToTokenRow(
  filePath: string,
  fileName: string,
  sheetName: string,
  row: ParsedRow,
  record: CanonicalRecord,
): MigrationTokenRow | null {
  const tokenAddress = getByAliases(record, TOKEN_HEADER_ALIASES.tokenAddress);
  if (!tokenAddress || !BASE58_RE.test(tokenAddress)) return null;

  const rawTicker = getByAliases(record, TOKEN_HEADER_ALIASES.ticker);
  const totalUniqueBuyers = parseInteger(getByAliases(record, TOKEN_HEADER_ALIASES.totalUniqueBuyers));
  const currentMc = parseHumanNumber(getByAliases(record, TOKEN_HEADER_ALIASES.currentMc));
  const marketCapMax = parseHumanNumber(getByAliases(record, TOKEN_HEADER_ALIASES.marketCapMax));
  const mintTimeText = getByAliases(record, TOKEN_HEADER_ALIASES.mintTimeText);
  const migrationTimeText = getByAliases(record, TOKEN_HEADER_ALIASES.migrationTimeText);
  const timeBeforeMigrationText = getByAliases(record, TOKEN_HEADER_ALIASES.timeBeforeMigrationText);
  const timeBeforeMigrationSeconds = parseDurationSeconds(timeBeforeMigrationText);

  return {
    filePath,
    fileName,
    sheetName,
    rowIndex: row.index,
    tokenAddress,
    ticker: rawTicker,
    totalUniqueBuyers,
    currentMc,
    marketCapMax,
    mintTimeText,
    migrationTimeText,
    timeBeforeMigrationText,
    timeBeforeMigrationSeconds,
    creator: null,
    creatorSource: null,
    raw: record.raw,
  };
}

function rowToWalletRow(
  filePath: string,
  fileName: string,
  sheetName: string,
  row: ParsedRow,
  record: CanonicalRecord,
): MigrationWalletRow | null {
  const wallet = getByAliases(record, WALLET_HEADER_ALIASES.wallet);
  if (!wallet || !BASE58_RE.test(wallet)) return null;

  return {
    filePath,
    fileName,
    sheetName,
    rowIndex: row.index,
    wallet,
    wr: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.wr)),
    roi: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.roi)),
    pnl: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.pnl)),
    rockets: parseInteger(getByAliases(record, WALLET_HEADER_ALIASES.rockets)),
    medianRoi: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.medianRoi)),
    avgRoi: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.avgRoi)),
    fastTrades: parseInteger(getByExactHeader(record, ["Fast Trades"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.fastTrades)),
    fastTradesPct: parseHumanNumber(getByExactHeader(record, ["Fast Trades %"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.fastTradesPct)),
    balance: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.balance)),
    totalTokens: parseInteger(getByAliases(record, WALLET_HEADER_ALIASES.totalTokens)),
    soldGtBought: parseInteger(getByExactHeader(record, ["Sold > Bought"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.soldGtBought)),
    soldGtBoughtPct: parseHumanNumber(getByExactHeader(record, ["Sold > Bought %"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.soldGtBoughtPct)),
    avgTradeDurationText: getByAliases(record, WALLET_HEADER_ALIASES.avgTradeDurationText),
    pfTokens: parseInteger(getByAliases(record, WALLET_HEADER_ALIASES.pfTokens)),
    pfTradesPct: parseHumanNumber(getByExactHeader(record, ["% PF Trades"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.pfTradesPct)),
    avgBuySol: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.avgBuySol)),
    medianSolBuy: parseHumanNumber(getByAliases(record, WALLET_HEADER_ALIASES.medianSolBuy)),
    avgMcapFirstTx: getByExactHeader(record, ["AVG Mcap First Tx"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.avgMcapFirstTx),
    avgMcapLastTx: getByExactHeader(record, ["AVG Mcap Last Tx"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.avgMcapLastTx),
    lastTradeText: getByExactHeader(record, ["Last Trade"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.lastTradeText),
    lastTradeHour: extractHour(getByAliases(record, WALLET_HEADER_ALIASES.lastTradeText)),
    migratedTokens: parseInteger(getByAliases(record, WALLET_HEADER_ALIASES.migratedTokens)),
    migratedPct: parseHumanNumber(getByExactHeader(record, ["% Migrated"]) ?? getByAliases(record, WALLET_HEADER_ALIASES.migratedPct)),
    raw: record.raw,
  };
}

function summarizeTokens(rows: MigrationTokenRow[]): TokenSummary {
  const byAddress = new Map<string, MigrationTokenRow>();
  const mintHourCounts = new Map<number, number>();
  const migrationHourCounts = new Map<number, number>();
  let sum = 0;
  let seenDurations = 0;
  let min = Infinity;
  let max = -Infinity;
  let withCreator = 0;

  for (const row of rows) {
    byAddress.set(row.tokenAddress, row);
    if (row.creator) withCreator += 1;
    if (row.timeBeforeMigrationSeconds != null) {
      sum += row.timeBeforeMigrationSeconds;
      seenDurations += 1;
      min = Math.min(min, row.timeBeforeMigrationSeconds);
      max = Math.max(max, row.timeBeforeMigrationSeconds);
    }
    const mintHour = extractHour(row.mintTimeText);
    if (mintHour != null) mintHourCounts.set(mintHour, (mintHourCounts.get(mintHour) ?? 0) + 1);
    const migHour = extractHour(row.migrationTimeText);
    if (migHour != null) migrationHourCounts.set(migHour, (migrationHourCounts.get(migHour) ?? 0) + 1);
  }

  const topByMarketCap = [...rows]
    .sort((a, b) => (b.marketCapMax ?? 0) - (a.marketCapMax ?? 0))
    .slice(0, 10)
    .map((row) => ({ tokenAddress: row.tokenAddress, ticker: row.ticker, marketCapMax: row.marketCapMax }));

  const topByCurrentMc = [...rows]
    .sort((a, b) => (b.currentMc ?? 0) - (a.currentMc ?? 0))
    .slice(0, 10)
    .map((row) => ({ tokenAddress: row.tokenAddress, ticker: row.ticker, currentMc: row.currentMc }));

  return {
    rows: rows.length,
    uniqueTokens: byAddress.size,
    migratedTokens: rows.length,
    withCreator,
    avgTimeBeforeMigrationSeconds: seenDurations > 0 ? Math.round(sum / seenDurations) : null,
    minTimeBeforeMigrationSeconds: seenDurations > 0 ? min : null,
    maxTimeBeforeMigrationSeconds: seenDurations > 0 ? max : null,
    topByMarketCap,
    topByCurrentMc,
    mintHourHistogram: [...mintHourCounts.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
    migrationHourHistogram: [...migrationHourCounts.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
  };
}

function summarizeWallets(rows: MigrationWalletRow[]): WalletSummary {
  const byWallet = new Map<string, MigrationWalletRow>();
  const lastTradeHourCounts = new Map<number, number>();
  for (const row of rows) {
    byWallet.set(row.wallet, row);
    if (row.lastTradeHour != null) lastTradeHourCounts.set(row.lastTradeHour, (lastTradeHourCounts.get(row.lastTradeHour) ?? 0) + 1);
  }

  const sortedPnl = [...rows].sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity));
  const sortedRoi = [...rows].sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));

  return {
    rows: rows.length,
    uniqueWallets: byWallet.size,
    topPnl: sortedPnl.slice(0, 10).map((row) => ({ wallet: row.wallet, pnl: row.pnl, roi: row.roi })),
    worstPnl: [...rows].sort((a, b) => (a.pnl ?? Infinity) - (b.pnl ?? Infinity)).slice(0, 10).map((row) => ({ wallet: row.wallet, pnl: row.pnl, roi: row.roi })),
    topRoi: sortedRoi.slice(0, 10).map((row) => ({ wallet: row.wallet, pnl: row.pnl, roi: row.roi })),
    worstRoi: [...rows].sort((a, b) => (a.roi ?? Infinity) - (b.roi ?? Infinity)).slice(0, 10).map((row) => ({ wallet: row.wallet, pnl: row.pnl, roi: row.roi })),
    lastTradeHourHistogram: [...lastTradeHourCounts.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
  };
}

async function maybeResolveCreators(
  tokenRows: MigrationTokenRow[],
  resolveEnabled: boolean,
  resolveLimit: number,
): Promise<{ resolvedCount: number; creatorBuckets: Map<string, MigrationTokenRow[]> }> {
  if (!resolveEnabled || tokenRows.length === 0) {
    return { resolvedCount: 0, creatorBuckets: new Map() };
  }

  const creatorBuckets = new Map<string, MigrationTokenRow[]>();
  const seen = new Set<string>();
  let resolvedCount = 0;

  for (const row of tokenRows) {
    if (resolvedCount >= resolveLimit) break;
    if (row.creator) continue;
    if (seen.has(row.tokenAddress)) continue;
    seen.add(row.tokenAddress);

    const creator = await getCreatorForMint(row.tokenAddress);
    if (!creator || !BASE58_RE.test(creator)) continue;

    row.creator = creator;
    row.creatorSource = "resolved";
    resolvedCount += 1;
    if (!creatorBuckets.has(creator)) creatorBuckets.set(creator, []);
    creatorBuckets.get(creator)!.push(row);
  }

  return { resolvedCount, creatorBuckets };
}

function buildDevWalletFromCreator(creator: string, rows: MigrationTokenRow[]) {
  const now = Date.now();
  const migratedCount = rows.filter((row) => {
    const maxMc = row.marketCapMax ?? row.currentMc ?? 0;
    return maxMc > 0;
  }).length;
  const reached300kCount = rows.filter((row) => (row.marketCapMax ?? row.currentMc ?? 0) >= 300_000).length;
  const mcValues = rows
    .map((row) => row.marketCapMax ?? row.currentMc ?? 0)
    .filter((value) => value > 0);
  const createdTimes = rows
    .map((row) => parseWorkbookDate(row.mintTimeText))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const hourCounts = new Array<number>(24).fill(0);
  for (const row of rows) {
    const hour = extractHour(row.mintTimeText);
    if (hour !== null) hourCounts[hour] += 1;
  }
  let bestLaunchHour: number | null = null;
  let bestHourCount = 0;
  for (let i = 0; i < hourCounts.length; i += 1) {
    if (hourCounts[i] > bestHourCount) {
      bestHourCount = hourCounts[i];
      bestLaunchHour = i;
    }
  }

  return {
    address: creator,
    totalTokens: rows.length,
    migratedCount,
    migrationRate: rows.length > 0 ? migratedCount / rows.length : 0,
    reached300kCount,
    rate300k: rows.length > 0 ? reached300kCount / rows.length : 0,
    bestLaunchHour,
    totalVolumeSol: 0,
    totalFeesSol: 0,
    avgMcUsd: mcValues.length > 0 ? mcValues.reduce((sum, value) => sum + value, 0) / mcValues.length : null,
    maxMcUsd: mcValues.length > 0 ? Math.max(...mcValues) : null,
    source: "xlsx",
    firstSeenAt: createdTimes[0] != null ? createdTimes[0] * 1000 : Date.now(),
    lastUpdatedAt: now,
  };
}

async function importWorkbook(filePath: string, args: ParsedArgs) {
  const workbook = extractWorkbook(filePath);
  const fileName = path.basename(filePath);
  const allTokenRows: MigrationTokenRow[] = [];
  const allWalletRows: MigrationWalletRow[] = [];
  const summaries: Record<string, unknown> = {};
  const sheetKinds = new Set<MigrationWorkbookKind>();

  for (const sheet of workbook.sheets) {
    if (sheet.rows.length === 0) continue;
    const headerRow = sheet.rows[0];
    const headerByColumn = new Map<string, string>();
    for (const cell of headerRow.cells) {
      const header = cell.value === null || cell.value === undefined ? "" : String(cell.value).trim();
      if (!header) continue;
      headerByColumn.set(columnFromRef(cell.ref), header);
    }

    const headers = [...headerByColumn.values()];
    const kind = detectSheetKind(headers);
    sheetKinds.add(kind);

    const tokenRows: MigrationTokenRow[] = [];
    const walletRows: MigrationWalletRow[] = [];

    for (const row of sheet.rows.slice(1)) {
      const record = buildCanonicalRecord(row, headerByColumn);
      if (kind === "token_report" || kind === "mixed") {
        const tokenRow = rowToTokenRow(filePath, fileName, sheet.name, row, record);
        if (tokenRow) {
          tokenRows.push(tokenRow);
          continue;
        }
      }
      if (kind === "wallet_report" || kind === "mixed") {
        const walletRow = rowToWalletRow(filePath, fileName, sheet.name, row, record);
        if (walletRow) {
          walletRows.push(walletRow);
          continue;
        }
      }
    }

    if (tokenRows.length > 0) {
      summaries[`token:${sheet.name}`] = summarizeTokens(tokenRows);
      allTokenRows.push(...tokenRows);
    }
    if (walletRows.length > 0) {
      summaries[`wallet:${sheet.name}`] = summarizeWallets(walletRows);
      allWalletRows.push(...walletRows);
    }
  }

  const workbookKind: MigrationWorkbookKind = sheetKinds.has("mixed")
    ? "mixed"
    : sheetKinds.has("token_report")
      ? "token_report"
      : sheetKinds.has("wallet_report")
        ? "wallet_report"
        : "unknown";

  const { resolvedCount, creatorBuckets } = await maybeResolveCreators(allTokenRows, args.resolveCreators, args.resolveLimit);

  if (args.resolveCreators && creatorBuckets.size > 0) {
    const devTokenRows: DevTokenRow[] = [];
    for (const [creator, rows] of creatorBuckets.entries()) {
      const devWallet = buildDevWalletFromCreator(creator, rows);
      persistDevWallet(devWallet);

      for (const row of rows) {
        devTokenRows.push({
          mint: row.tokenAddress,
          creator,
          symbol: row.ticker,
          name: row.ticker,
          image: null,
          description: null,
          twitter: null,
          telegram: null,
          website: null,
          createdAt: parseWorkbookDate(row.mintTimeText),
          marketCapUsd: row.currentMc,
          athUsd: row.marketCapMax,
          isMigrated: true,
          reached300k: (row.marketCapMax ?? row.currentMc ?? 0) >= 300_000,
          totalSupply: null,
          source: "xlsx",
          lastUpdatedAt: Date.now(),
        });
      }
    }
    if (devTokenRows.length > 0) persistDevTokens(devTokenRows);
  }

  persistMigrationXlsxFile({
    filePath,
    fileName,
    workbookKind,
    sheetCount: workbook.sheets.length,
    totalRows: allTokenRows.length + allWalletRows.length,
    tokenRows: allTokenRows.length,
    walletRows: allWalletRows.length,
    summary: {
      fileName,
      workbookKind,
      sheets: workbook.sheets.length,
      resolvedCreators: resolvedCount,
      ...summaries,
    },
  });

  persistMigrationTokenRows(allTokenRows);
  persistMigrationWalletRows(allWalletRows);

  return {
    filePath,
    fileName,
    workbookKind,
    sheets: workbook.sheets.length,
    tokenRows: allTokenRows.length,
    walletRows: allWalletRows.length,
    resolvedCreators: resolvedCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h") || !args.dir) {
    printUsage();
    process.exit(0);
  }

  const targetFiles = args.file
    ? [path.resolve(PROJECT_ROOT, args.file)]
    : listXlsxFiles(path.resolve(args.dir));

  if (targetFiles.length === 0) {
    console.error("No .xlsx files found.");
    process.exit(1);
  }

  const limited = args.maxFiles != null ? targetFiles.slice(0, args.maxFiles) : targetFiles;
  const db = getDb();
  db.pragma("wal_checkpoint(TRUNCATE)");

  const results = [];
  for (const filePath of limited) {
    if (!fs.existsSync(filePath)) {
      console.warn(`[skip] Missing file: ${filePath}`);
      continue;
    }
    const result = await importWorkbook(filePath, args);
    results.push(result);
    console.log(JSON.stringify(result));
  }

  console.log(JSON.stringify({
    importedFiles: results.length,
    totalTokenRows: results.reduce((sum, row) => sum + row.tokenRows, 0),
    totalWalletRows: results.reduce((sum, row) => sum + row.walletRows, 0),
    resolvedCreators: results.reduce((sum, row) => sum + row.resolvedCreators, 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

