// data-tag: lib.trade.pumpfun
// Pump.fun public swap-api — no API key required.
// Endpoint: https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=100&cursor=...
// (frontend-api.pump.fun is blocked / returns 530; swap-api is the public replacement
//  already used in app/api/token-trades/route.ts)
import type { RawTrade } from "./helius";

const PUMP_API = "https://swap-api.pump.fun/v2";

interface V2Trade {
  tx: string;
  timestamp: string;     // ISO 8601
  userAddress: string;
  type: "buy" | "sell";
  program?: string;
  priceUsd?: string;
  amountUsd?: string;
  amountSol: string;     // SOL (decimal-adjusted)
  baseAmount: string;    // tokens (decimal-adjusted)
  quoteAmount?: string;
}

interface V2Resp {
  trades?: V2Trade[];
  pagination?: { hasMore?: boolean; nextCursor?: string };
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Fetch a single page with retry on 429.
 */
async function fetchPage(url: string, attempt = 0): Promise<V2Resp> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  } catch (e) {
    if (attempt < 3) {
      await sleep(500 * 2 ** attempt);
      return fetchPage(url, attempt + 1);
    }
    throw new Error(`network error: ${(e as Error).message}`);
  }

  if (r.status === 429) {
    if (attempt >= 10) {
      throw new Error("HTTP 429: rate limited (max retries exceeded)");
    }
    // Honour Retry-After header if present, else exponential backoff with longer base
    const retryAfter = Number(r.headers.get("retry-after")) || 0;
    const wait = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
    console.log(`[fetchPage] 429 rate limit, attempt ${attempt + 1}/10, waiting ${wait}ms`);
    await sleep(wait);
    return fetchPage(url, attempt + 1);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${r.statusText}: ${body.slice(0, 200)}`);
  }

  return (await r.json()) as V2Resp;
}

/**
 * Fetch trades from Pump.fun swap-api with cursor pagination + throttling.
 */
export async function fetchPumpTrades(
  mint: string,
  maxTrades: number = 1000,
  onProgress?: (info: { fetched: number; page: number }) => void
): Promise<RawTrade[]> {
  const out: RawTrade[] = [];
  const pageSize = 100;
  let pageNum = 0;

  const buildUrl = (cursor?: string) => {
    const url = new URL(`${PUMP_API}/coins/${mint}/trades`);
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("cursor", cursor);
    return url.toString();
  };

  // ── Pipeline trick ──────────────────────────────────────────
  // Cursor pagination is inherently sequential (need cursor[N] to start fetch[N+1]),
  // BUT we can overlap the network fetch of page[N+1] with the CPU parsing of page[N].
  // Even better: as soon as we see nextCursor in headers/body of page N, kick off
  // page N+1 in flight while we still loop through page N's items.
  let inflight: Promise<V2Resp> | null = fetchPage(buildUrl(undefined));

  while (out.length < maxTrades && inflight) {
    const data: V2Resp = await inflight;
    const page = data.trades ?? [];

    // Kick off the NEXT request immediately, before parsing this page
    const nextCursor = data.pagination?.hasMore ? data.pagination?.nextCursor : undefined;
    inflight = nextCursor ? fetchPage(buildUrl(nextCursor)) : null;

    if (page.length === 0) break;

    for (const t of page) {
      const amountSol = Number(t.amountSol) || 0;
      const amountTokens = Number(t.baseAmount) || 0;
      if (amountSol < 1e-9 || amountTokens < 1e-9) continue;
      const ts = Math.floor(new Date(t.timestamp).getTime() / 1000);
      out.push({
        signature: t.tx,
        timestamp: ts,
        trader: t.userAddress,
        type: t.type,
        amountSol,
        amountTokens,
        priceSol: amountSol / amountTokens,
        source: t.program || "PUMP_FUN",
      });
    }
    pageNum++;
    onProgress?.({ fetched: out.length, page: pageNum });

    // Small delay between pages to avoid rate limiting
    if (inflight) await sleep(100);
  }

  // If we hit maxTrades but still have an in-flight request, drain it gracefully
  // (no awaiting — let it complete in background without blocking response)
  if (inflight) inflight.catch(() => {});

  console.log(`[fetchPumpTrades] mint=${mint.slice(0,8)}... fetched=${out.length} trades (maxTrades=${maxTrades})`);
  return out.slice(0, maxTrades);
}

/**
 * Detect if token exists on pump.fun via metadata endpoint.
 */
export async function isPumpFunToken(mint: string): Promise<boolean> {
  try {
    const r = await fetch(`${PUMP_API}/coins/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch creator wallet directly from Pump.fun metadata.
 * Pump.fun's coin endpoint includes the creator (the user who launched the token),
 * which is more reliable than Helius DAS for pump.fun tokens (DAS often returns the
 * program address instead of the actual user).
 */
export async function getPumpCreator(mint: string): Promise<string | null> {
  const readCreator = (data: Record<string, unknown>) => {
    const candidates = [
      data.creator, data.creatorAddress, data.creator_address,
      data.deployer, data.userAddress, data.user_address,
      (data.metadata as Record<string, unknown> | undefined)?.creator,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c)) return c;
    }
    return null;
  };

  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const creator = readCreator((await r.json()) as Record<string, unknown>);
      if (creator) return creator;
    }
  } catch {
    // continue to swap-api fallback
  }

  try {
    const r = await fetch(`${PUMP_API}/coins/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const data = (await r.json()) as Record<string, unknown>;
    return readCreator(data);
  } catch {
    return null;
  }
}

/**
 * Last-resort creator detection: take the very first trader on this token.
 * On pump.fun the creator must perform a buy at launch, so the earliest trade's
 * userAddress is almost always the creator.
 */
export async function getCreatorFromFirstTrade(mint: string): Promise<string | null> {
  try {
    const url = new URL(`${PUMP_API}/coins/${mint}/trades`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("sort", "asc");
    const r = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json()) as { trades?: { userAddress?: string }[] };
    const first = data.trades?.[0]?.userAddress;
    return typeof first === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Fetch total volume from Pump.fun v2/trades with pagination.
 * Returns totalSol and uniqueTraders count.
 * Used for accurate total volume calculation (not just 24h).
 */
export async function fetchPumpTotalVolume(mint: string, maxPages: number = 3): Promise<{ totalSol: number; uniqueTraders: number } | null> {
  try {
    const PAGE = 100;
    const BASE = `${PUMP_API}/coins/${mint}/trades`;

    type Trade = { amountSol: string; walletAddress?: string; trader?: string };
    type Resp = { trades?: Trade[]; pagination?: { hasMore?: boolean; nextCursor?: string } };

    const d1 = await fetchPage(`${BASE}?limit=${PAGE}`);
    const pages: Trade[][] = [d1.trades ?? []];

    if (d1.pagination?.hasMore && d1.pagination.nextCursor) {
      let nextCursor: string | undefined = d1.pagination.nextCursor;
      for (let i = 1; i < maxPages && nextCursor; i++) {
        const dN = await fetchPage(`${BASE}?limit=${PAGE}&cursor=${encodeURIComponent(nextCursor)}`);
        pages.push(dN.trades ?? []);
        if (!dN.pagination?.hasMore || !dN.pagination.nextCursor) break;
        nextCursor = dN.pagination.nextCursor;
      }
    }

    let totalSol = 0;
    const wallets = new Set<string>();
    for (const page of pages) {
      for (const t of page) {
        totalSol += Number(t.amountSol) || 0;
        const w = t.walletAddress || t.trader;
        if (w) wallets.add(w);
      }
    }

    if (totalSol <= 0) return null;
    return { totalSol, uniqueTraders: wallets.size };
  } catch {
    return null;
  }
}
