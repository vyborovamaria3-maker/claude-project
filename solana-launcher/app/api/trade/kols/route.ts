import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLI_TIMEOUT_MS = 18_000;
const CACHE_TTL_MS = 90_000;

type RawRecord = Record<string, unknown>;

type NormalizedTrade = {
  source: "kol" | "smartmoney";
  maker: string;
  side: string;
  tokenAddress: string;
  symbol: string | null;
  amountUsd: number | null;
  tokenAmount: number | null;
  priceUsd: number | null;
  buyCostUsd: number | null;
  priceNow: number | null;
  priceChange: number | null;
  timestamp: number | null;
  positionAction: "open_add" | "close_reduce" | "unknown";
  launchpad: string | null;
  twitterUsername: string | null;
  twitterName: string | null;
  avatar: string | null;
  tags: string[];
  transactionHash: string | null;
};

type LiveSignal = {
  id: string | null;
  tokenAddress: string;
  signalType: number | null;
  triggerAt: number | null;
  triggerMc: number | null;
  marketCap: number | null;
  signalTimes: number | null;
};

type Snapshot = {
  fetchedAt: number;
  kol: NormalizedTrade[];
  smart: NormalizedTrade[];
  live: LiveSignal[];
  errors: string[];
  stale: boolean;
};

let cache: Snapshot | null = null;
let refreshInFlight: Promise<Snapshot> | null = null;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function rowsFromPayload(value: unknown): RawRecord[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is RawRecord => Boolean(item) && typeof item === "object") as RawRecord[];
  }
  const root = asRecord(value);
  for (const key of ["list", "data", "items", "result"]) {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is RawRecord => Boolean(item) && typeof item === "object") as RawRecord[];
    }
    const nested = asRecord(candidate);
    if (Array.isArray(nested.list)) {
      return nested.list.filter((item): item is RawRecord => Boolean(item) && typeof item === "object") as RawRecord[];
    }
  }
  return [];
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("gmgn-cli returned empty output");
  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf("{");
    const arrayStart = text.indexOf("[");
    const starts = [objectStart, arrayStart].filter((value) => value >= 0);
    if (!starts.length) throw new Error("gmgn-cli did not return JSON");
    const start = Math.min(...starts);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end <= start) throw new Error("gmgn-cli returned malformed JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}

function runtimeGmgnApiKey(): string {
  // Dynamic property access prevents build-time env folding in Next/Turbopack.
  const name = ["GMGN", "API", "KEY"].join("_");
  return process.env[name]?.trim() || "";
}

function runCli(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const apiKey = runtimeGmgnApiKey();
    const child = spawn("gmgn-cli", args, {
      shell: false,
      env: { ...process.env, GMGN_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("gmgn-cli timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `gmgn-cli exited with ${code ?? "unknown"}`));
        return;
      }
      try {
        resolve(parseJsonOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeTrade(row: RawRecord, source: "kol" | "smartmoney"): NormalizedTrade {
  const makerInfo = asRecord(row.maker_info);
  const baseToken = asRecord(row.base_token);
  const openClose = asNumber(row.is_open_or_close);
  return {
    source,
    maker: asString(row.maker) || asString(makerInfo.address) || "unknown",
    side: (asString(row.side) || "unknown").toLowerCase(),
    tokenAddress: asString(row.base_address) || asString(baseToken.address) || "",
    symbol: asString(baseToken.symbol) || asString(row.symbol),
    amountUsd: asNumber(row.amount_usd),
    tokenAmount: asNumber(row.token_amount) ?? asNumber(row.base_amount),
    priceUsd: asNumber(row.price_usd),
    buyCostUsd: asNumber(row.buy_cost_usd),
    priceNow: asNumber(row.price_now),
    priceChange: asNumber(row.price_change),
    timestamp: asNumber(row.timestamp),
    positionAction: openClose === 0 ? "open_add" : openClose === 1 ? "close_reduce" : "unknown",
    launchpad: asString(row.launchpad) || asString(baseToken.launchpad) || asString(row.launchpad_platform),
    twitterUsername: asString(makerInfo.twitter_username),
    twitterName: asString(makerInfo.twitter_name) || asString(makerInfo.name),
    avatar: asString(makerInfo.avatar),
    tags: asStringArray(makerInfo.tags),
    transactionHash: asString(row.transaction_hash),
  };
}

function normalizeLiveSignal(row: RawRecord): LiveSignal {
  return {
    id: asString(row.id),
    tokenAddress: asString(row.token_address) || asString(row.address) || "",
    signalType: asNumber(row.signal_type),
    triggerAt: asNumber(row.trigger_at),
    triggerMc: asNumber(row.trigger_mc),
    marketCap: asNumber(row.market_cap),
    signalTimes: asNumber(row.signal_times),
  };
}

function dedupeTrades(rows: NormalizedTrade[]): NormalizedTrade[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = [row.source, row.transactionHash || "nohash", row.maker, row.tokenAddress, row.side].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function refreshSnapshot(): Promise<Snapshot> {
  const previous = cache;
  const results = await Promise.allSettled([
    runCli(["track", "kol", "--chain", "sol", "--limit", "200", "--raw"]),
    runCli(["track", "smartmoney", "--chain", "sol", "--limit", "200", "--raw"]),
    runCli(["market", "signal", "--chain", "sol", "--signal-type", "9", "--raw"]),
  ]);

  const errors = results.flatMap((result, index) => result.status === "rejected"
    ? [`${["kol", "smartmoney", "live"][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : []);

  const kolResult = results[0];
  const smartResult = results[1];
  const liveResult = results[2];

  const kolOk = kolResult.status === "fulfilled";
  const smartOk = smartResult.status === "fulfilled";
  const liveOk = liveResult.status === "fulfilled";

  if (!kolOk && !smartOk && !liveOk && previous) {
    return { ...previous, errors, stale: true };
  }

  const kol = kolResult.status === "fulfilled"
    ? dedupeTrades(rowsFromPayload(kolResult.value).map((row) => normalizeTrade(row, "kol")))
    : (previous?.kol || []);
  const smart = smartResult.status === "fulfilled"
    ? dedupeTrades(rowsFromPayload(smartResult.value).map((row) => normalizeTrade(row, "smartmoney")))
    : (previous?.smart || []);
  const live = liveResult.status === "fulfilled"
    ? rowsFromPayload(liveResult.value).map(normalizeLiveSignal)
    : (previous?.live || []);

  return { fetchedAt: Date.now(), kol, smart, live, errors, stale: false };
}

async function getSnapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshSnapshot()
    .then((snapshot) => {
      cache = snapshot;
      return snapshot;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!MINT_RE.test(mint)) {
    return NextResponse.json({ available: false, error: "invalid mint" }, { status: 400 });
  }

  if (!runtimeGmgnApiKey()) {
    return NextResponse.json({
      available: false,
      configured: false,
      error: "GMGN_API_KEY is missing in frontend runtime",
      mint,
      kolTrades: [],
      smartMoneyTrades: [],
      liveSignals: [],
    });
  }

  try {
    const snapshot = await getSnapshot();
    const kolTrades = snapshot.kol.filter((row) => row.tokenAddress === mint);
    const smartMoneyTrades = snapshot.smart.filter((row) => row.tokenAddress === mint);
    const liveSignals = snapshot.live.filter((row) => row.tokenAddress === mint);

    return NextResponse.json({
      available: kolTrades.length > 0 || smartMoneyTrades.length > 0 || liveSignals.length > 0 || snapshot.errors.length === 0,
      configured: true,
      mint,
      kolTrades,
      smartMoneyTrades,
      liveSignals,
      errors: snapshot.errors,
      stale: snapshot.stale,
      cacheTtlMs: CACHE_TTL_MS,
      fetchedAt: snapshot.fetchedAt,
    });
  } catch (error) {
    return NextResponse.json({
      available: false,
      configured: true,
      mint,
      kolTrades: [],
      smartMoneyTrades: [],
      liveSignals: [],
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}
