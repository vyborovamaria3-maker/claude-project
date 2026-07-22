import fs from "node:fs";
import path from "node:path";
import { getApifyRun, getDevTokensByCreator, listApifyRuns, listApifySyncEvents, persistApifyRun, persistApifySyncEvent, persistDevTokens, persistDevWallet, type ApifyRunRow, type ApifySyncEventRow, type DevTokenRow } from "@/lib/trade/db";

export type ApifyActorType = "sandbox" | "pumpfun-scraper";

const DB_PATH = path.join(process.cwd(), "data", "trade.db");
const APIFY_SUMMARY_CACHE_TTL_MS = 5_000;

type ApifySummary = ReturnType<typeof buildApifySummary>;

let apifySummaryCache: {
  signature: string;
  fetchedAt: number;
  data: ApifySummary;
} | null = null;

function getDbSignature() {
  try {
    const stat = fs.statSync(DB_PATH);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export type ApifyActorRun = {
  id: string;
  actId?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string | null;
  defaultDatasetId?: string | null;
  usageTotalUsd?: number | null;
};

export type ApifyPublicRun = {
  runId: string;
  actorId: string;
  actorType: string;
  status: string;
  defaultDatasetId: string | null;
  startedAt: number;
  finishedAt: number | null;
  input: unknown;
  meta: unknown;
  lastSyncedAt: number;
  urls: {
    base: string;
    shell: string;
    mcp: string;
  };
};

export type ApifyConfigSummary = {
  tokenConfigured: boolean;
  apiBaseUrl: string;
  sandboxActorId: string;
  pumpfunActorId: string;
};

export type PumpFunSyncInput = {
  maxItems?: number;
  sortBy?: string;
  order?: "ASC" | "DESC";
  includeNsfw?: boolean;
  includeDetails?: boolean;
};

const DEFAULT_SANDBOX_ACTOR = "apify/ai-sandbox";
const DEFAULT_PUMPFUN_ACTOR = "parseforge/pump-fun-scraper";
const DEFAULT_API_BASE_URL = "https://api.apify.com/v2";

function getApiToken() {
  return process.env.APIFY_API_TOKEN?.trim() || "";
}

function getApiBaseUrl() {
  return process.env.APIFY_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
}

export function getApifyConfigSummary(): ApifyConfigSummary {
  return {
    tokenConfigured: Boolean(getApiToken()),
    apiBaseUrl: getApiBaseUrl(),
    sandboxActorId: process.env.APIFY_SANDBOX_ACTOR_ID?.trim() || DEFAULT_SANDBOX_ACTOR,
    pumpfunActorId: process.env.APIFY_PUMPFUN_SCRAPER_ACTOR_ID?.trim() || DEFAULT_PUMPFUN_ACTOR,
  };
}

function requireToken() {
  const token = getApiToken();
  if (!token) {
    throw new Error("APIFY_API_TOKEN is not configured");
  }
  return token;
}

function normalizeActorId(actorId: string) {
  return actorId.trim().replace(/\//g, "~");
}

function getActorIdByType(actorType: ApifyActorType) {
  const cfg = getApifyConfigSummary();
  return actorType === "sandbox" ? cfg.sandboxActorId : cfg.pumpfunActorId;
}

function buildApiUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const token = requireToken();
  const url = new URL(path, `${getApiBaseUrl()}/`);
  url.searchParams.set("token", token);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function apifyFetchJson<T>(path: string, init?: RequestInit, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const response = await fetch(buildApiUrl(path, params), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apify API ${response.status}: ${text.slice(0, 300) || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function apifyFetchData<T>(path: string, init?: RequestInit, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const payload = await apifyFetchJson<{ data: T }>(path, init, params);
  return payload.data;
}

function toTimestamp(value: unknown) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const normalized = value.replace(/[$,_\s]/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y" || normalized === "graduated";
  }
  return false;
}

function readField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  return null;
}

function toRunRow(actorId: string, actorType: ApifyActorType, input: unknown, run: ApifyActorRun): ApifyRunRow {
  const startedAt = toTimestamp(run.startedAt) ? (toTimestamp(run.startedAt) as number) * 1000 : Date.now();
  const finishedAtSec = toTimestamp(run.finishedAt);
  return {
    runId: run.id,
    actorId,
    actorType,
    status: run.status,
    defaultDatasetId: run.defaultDatasetId ?? null,
    startedAt,
    finishedAt: finishedAtSec ? finishedAtSec * 1000 : null,
    input,
    meta: {
      actId: run.actId ?? null,
      usageTotalUsd: run.usageTotalUsd ?? null,
    },
    lastSyncedAt: Date.now(),
  };
}

function buildRunUrls(runId: string) {
  const base = `https://${runId}.runs.apify.net`;
  return {
    base,
    shell: `${base}/shell/`,
    mcp: `${base}/mcp`,
  };
}

export function toPublicRun(row: ApifyRunRow | null): ApifyPublicRun | null {
  if (!row) return null;
  return {
    ...row,
    urls: buildRunUrls(row.runId),
  };
}

export async function runApifyActor(actorType: ApifyActorType, input: unknown) {
  const actorId = getActorIdByType(actorType);
  const run = await apifyFetchData<ApifyActorRun>(`acts/${encodeURIComponent(normalizeActorId(actorId))}/runs`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
  const row = toRunRow(actorId, actorType, input, run);
  persistApifyRun(row);
  return toPublicRun(row);
}

export async function refreshApifyRun(runId: string) {
  const stored = getApifyRun(runId);
  const run = await apifyFetchData<ApifyActorRun>(`actor-runs/${encodeURIComponent(runId)}`);
  const actorId = stored?.actorId ?? run.actId ?? "unknown";
  const actorType = stored?.actorType === "sandbox" ? "sandbox" : "pumpfun-scraper";
  const row = toRunRow(actorId, actorType, stored?.input ?? null, run);
  persistApifyRun(row);
  return toPublicRun(row);
}

export async function getApifyDatasetItems(datasetId: string, limit = 1000) {
  return apifyFetchJson<Record<string, unknown>[]>(`datasets/${encodeURIComponent(datasetId)}/items`, undefined, {
    clean: true,
    format: "json",
    limit,
  });
}

function normalizePumpFunToken(item: Record<string, unknown>): DevTokenRow | null {
  const mint = String(readField(item, ["mint_address", "mintAddress", "mint", "token_address", "tokenAddress"]) ?? "").trim();
  const creator = String(readField(item, ["creator_address", "creatorAddress", "creator", "creator_wallet", "developer_address", "dev_wallet"]) ?? "").trim();
  if (!mint || !creator) return null;

  const marketCapUsd = toNumber(readField(item, ["market_cap_usd", "marketCapUsd", "usd_market_cap", "marketCap"])) ?? null;
  const athUsd = toNumber(readField(item, ["ath_usd", "athUsd", "peak_market_cap_usd", "max_market_cap_usd"])) ?? null;
  const createdAt = toTimestamp(readField(item, ["created_at", "createdAt", "created_timestamp", "launch_timestamp", "launchTime"]));
  const migrated = toBoolean(readField(item, ["graduated_to_dex", "graduatedToDex", "is_migrated", "isMigrated", "complete", "bonding_curve_complete"]));
  const reached300k = (athUsd ?? marketCapUsd ?? 0) >= 300_000;

  return {
    mint,
    creator,
    symbol: (readField(item, ["token_symbol", "symbol", "ticker"]) as string | null) ?? null,
    name: (readField(item, ["token_name", "name", "tokenName"]) as string | null) ?? null,
    image: (readField(item, ["image", "image_url", "imageUrl", "logo", "logoUrl"]) as string | null) ?? null,
    description: (readField(item, ["description", "token_description"]) as string | null) ?? null,
    twitter: (readField(item, ["twitter", "twitter_url", "twitterUrl", "twitter_link"]) as string | null) ?? null,
    telegram: (readField(item, ["telegram", "telegram_url", "telegramUrl", "telegram_link"]) as string | null) ?? null,
    website: (readField(item, ["website", "website_url", "websiteUrl", "site"]) as string | null) ?? null,
    createdAt,
    marketCapUsd,
    athUsd,
    isMigrated: migrated,
    reached300k,
    totalSupply: toNumber(readField(item, ["total_supply", "totalSupply", "supply"])),
    source: "apify",
    lastUpdatedAt: Date.now(),
  };
}

function computeBestLaunchHour(tokens: DevTokenRow[]) {
  const counts = new Map<number, number>();
  for (const token of tokens) {
    if (!token.createdAt) continue;
    const hour = new Date(token.createdAt * 1000).getUTCHours();
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function aggregateCreator(creator: string) {
  const tokens = getDevTokensByCreator(creator, 10000);
  const totalTokens = tokens.length;
  const migratedCount = tokens.filter((token) => token.isMigrated).length;
  const reached300kCount = tokens.filter((token) => token.reached300k || (token.athUsd ?? token.marketCapUsd ?? 0) >= 300_000).length;
  const marketCaps = tokens.map((token) => token.marketCapUsd).filter((value): value is number => value != null && Number.isFinite(value));
  const peaks = tokens.map((token) => token.athUsd ?? token.marketCapUsd).filter((value): value is number => value != null && Number.isFinite(value));
  const createdAtValues = tokens.map((token) => token.createdAt).filter((value): value is number => value != null && Number.isFinite(value));
  const avgMcUsd = marketCaps.length ? marketCaps.reduce((sum, value) => sum + value, 0) / marketCaps.length : null;
  const maxMcUsd = peaks.length ? Math.max(...peaks) : null;
  const firstSeenAt = createdAtValues.length ? Math.min(...createdAtValues) * 1000 : Date.now();

  persistDevWallet({
    address: creator,
    totalTokens,
    migratedCount,
    migrationRate: totalTokens > 0 ? (migratedCount / totalTokens) * 100 : 0,
    reached300kCount,
    rate300k: totalTokens > 0 ? (reached300kCount / totalTokens) * 100 : 0,
    bestLaunchHour: computeBestLaunchHour(tokens),
    totalVolumeSol: 0,
    totalFeesSol: 0,
    avgMcUsd,
    maxMcUsd,
    source: "apify",
    firstSeenAt,
    lastUpdatedAt: Date.now(),
  });
}

export async function ingestPumpFunDataset(datasetId: string, runId?: string | null) {
  const items = await getApifyDatasetItems(datasetId, 1000);
  const tokens = items
    .map((item) => normalizePumpFunToken(item))
    .filter((item): item is DevTokenRow => item !== null);

  if (tokens.length === 0) {
    const event: ApifySyncEventRow = {
      source: "pumpfun-scraper",
      runId: runId ?? null,
      datasetId,
      status: "empty",
      importedItems: items.length,
      importedCreators: 0,
      importedTokens: 0,
      message: "Dataset did not contain recognizable mint + creator pairs",
      meta: null,
    };
    persistApifySyncEvent(event);
    return event;
  }

  persistDevTokens(tokens);

  const creators = [...new Set(tokens.map((token) => token.creator))];
  for (const creator of creators) {
    aggregateCreator(creator);
  }

  const event: ApifySyncEventRow = {
    source: "pumpfun-scraper",
    runId: runId ?? null,
    datasetId,
    status: "ingested",
    importedItems: items.length,
    importedCreators: creators.length,
    importedTokens: tokens.length,
    message: `Imported ${tokens.length} tokens across ${creators.length} creators`,
    meta: {
      skippedItems: Math.max(0, items.length - tokens.length),
    },
  };
  persistApifySyncEvent(event);
  return event;
}

function buildApifySummary() {
  const config = getApifyConfigSummary();
  return {
    config,
    latestSandboxRun: toPublicRun(listApifyRuns("sandbox", 1)[0] ?? null),
    latestPumpfunRun: toPublicRun(listApifyRuns("pumpfun-scraper", 1)[0] ?? null),
    recentRuns: listApifyRuns(undefined, 10).map((row) => toPublicRun(row)!),
    recentSyncs: listApifySyncEvents("pumpfun-scraper", 10),
  };
}

export function getApifySummary() {
  const signature = getDbSignature();
  const now = Date.now();

  if (apifySummaryCache && apifySummaryCache.signature === signature && now - apifySummaryCache.fetchedAt < APIFY_SUMMARY_CACHE_TTL_MS) {
    return apifySummaryCache.data;
  }

  const data = buildApifySummary();
  apifySummaryCache = {
    signature,
    fetchedAt: now,
    data,
  };

  return data;
}
