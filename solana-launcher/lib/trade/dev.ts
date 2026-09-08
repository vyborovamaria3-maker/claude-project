// data-tag: lib.trade.dev
// Dev/creator analysis: list all tokens created, migration rate, ATH, optimal launch time.
import { getCache, setCache, persistDevWallet, persistDevTokens, getDevWallet, getDevTokensByCreator, getPersistedCreatorForMint, type DevTokenRow } from "./db";
import { heliusFetch, SOL_MINT } from "./dev-helpers";
import { appendHeliusApiKey, getRuntimeHeliusApiKeys } from "./helius-rotation";

const FALLBACK_RPC_URL =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_QUICKNODE_RPC_URL ||
  process.env.QUICKNODE_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";
const SOLSCAN_API_TOKEN = process.env.SOLSCAN_API_TOKEN || "";
const PUMPFUN_JWT = process.env.PUMPFUN_JWT || "";

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const runtimeKeys = await getRuntimeHeliusApiKeys();
  const urls = Array.from(new Set([
    ...runtimeKeys.map((key) => appendHeliusApiKey("https://mainnet.helius-rpc.com/", key)),
    FALLBACK_RPC_URL,
  ].filter(Boolean)));
  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        lastError = new Error(`RPC HTTP ${r.status}`);
        continue;
      }
      const data = await r.json();
      if (data.error) {
        lastError = new Error(data.error.message || "RPC request failed");
        continue;
      }
      return data.result as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("RPC request failed");
    }
  }

  throw lastError || new Error("RPC request failed");
}

export interface DevToken {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number | null;       // unix sec, null if unknown
  marketCapUsd: number | null;    // current MC (from DexScreener)
  athUsd: number | null;
  isMigrated: boolean;            // moved to Raydium/AMM
  reached300k: boolean;
}

export interface DevAnalysis {
  address: string;
  totalTokensCreated: number;
  tokens: DevToken[];
  migratedCount: number;
  migrationRate: number;        // 0..1
  reached300kCount: number;
  rate300k: number;             // 0..1
  bestLaunchHourUtc: number | null;
  launchesByHour: number[];     // length 24
  userTag?: string | null;
  fetchedAt: number;

  // ── Risk metrics (added 2026-05) ────────────────────────────────────────
  riskScore: number;             // 0–100 (higher = riskier dev)
  riskLevel: "low" | "medium" | "high" | "critical";
  riskReasons: string[];         // human-readable explanations
  rugRate: number;               // 0..1 — % of tokens with MC < $5K (effectively dead)
  successRate: number;           // 0..1 — % reached >= $300K
  avgMcUsd: number | null;
  medianMcUsd: number | null;
  maxMcUsd: number | null;
  minTimeBetweenLaunchesSec: number | null;
  avgTimeBetweenLaunchesSec: number | null;
  daysSinceLastLaunch: number | null;
  bestToken: { mint: string; symbol: string; mcUsd: number } | null;
  worstToken: { mint: string; symbol: string; mcUsd: number } | null;
}

/**
 * Resolve creator wallet from a mint with multi-source fallback chain:
 *   1. Persisted dev token index (best for already analyzed mints)
 *   2. Pump.fun coin metadata (most accurate for pump.fun tokens)
 *   3. Helius DAS getAsset (works for non-pump SPL tokens)
 *   4. First-trade heuristic (creator must buy at launch on pump.fun)
 */
export async function getCreatorForMint(mint: string): Promise<string | null> {
  // Lazy import to avoid circular deps
  const { getPumpCreator, getCreatorFromFirstTrade } = await import("./pumpfun");
  const KNOWN_PROGRAMS = new Set([
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // pump.fun bonding curve program
    "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  ]);

  // 0. Persisted dev token rows (fastest + most reliable for already analyzed mints)
  try {
    const cachedCreator = getPersistedCreatorForMint(mint);
    if (cachedCreator && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cachedCreator) && !KNOWN_PROGRAMS.has(cachedCreator)) {
      return cachedCreator;
    }
  } catch {
    // ignore, continue to external resolution chain
  }

  // 1. Pump.fun metadata
  const pumpCreator = await getPumpCreator(mint);
  if (pumpCreator) return pumpCreator;

  try {
    const solscanInfo = await solscanApi<{ success?: boolean; data?: { creator?: string; owner?: string; mintAuthority?: string } }>(
      `/token?address=${mint}`
    );
    const solscanCreator = solscanInfo?.data?.creator || solscanInfo?.data?.owner || solscanInfo?.data?.mintAuthority;
    if (solscanCreator && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solscanCreator) && !KNOWN_PROGRAMS.has(solscanCreator)) {
      return solscanCreator;
    }
  } catch {
    // ignore, proceed to fallback
  }

  // 3. Helius DAS — but filter out known program addresses (pump.fun program itself)
  try {
    const asset = await rpc<{ creators?: { address: string }[]; authorities?: { address: string }[] }>(
      "getAsset",
      { id: mint }
    );
    const fromCreators = asset.creators?.find((c) => !KNOWN_PROGRAMS.has(c.address))?.address;
    const fromAuthorities = asset.authorities?.find((a) => !KNOWN_PROGRAMS.has(a.address))?.address;
    const dasCreator = fromCreators || fromAuthorities;
    if (dasCreator) return dasCreator;
  } catch {
    // ignore, proceed to fallback
  }

  // 4. Last resort: first trader on the token
  return await getCreatorFromFirstTrade(mint);
}

/**
 * Fetch tokens created by a wallet via GMGN.ai API (unofficial).
 * NOTE: This uses reverse-engineered endpoints and may break if GMGN changes their API.
 */
async function fetchCreatorTokensGMGN(creator: string): Promise<DevToken[]> {
  try {
    // GMGN creator tokens endpoint (found via browser DevTools)
    const url = `https://gmgn.ai/defi/quotation/v1/tokens/sol/creator/${creator}?limit=1000`;
    
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0",
        "Referer": "https://gmgn.ai/",
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    
    clearTimeout(t);
    
    if (!r.ok) {
      console.log("[GMGN] API returned:", r.status);
      return [];
    }
    
    const json = await r.json();
    const items = json.data || json.tokens || json.items || [];
    
    return items.map((t: any) => ({
      mint: t.address || t.mint || t.token_address,
      symbol: t.symbol || "",
      name: t.name || "",
      createdAt: t.created_timestamp ? Math.floor(t.created_timestamp / 1000) : 
                t.created_at ? Math.floor(t.created_at / 1000) : null,
      marketCapUsd: t.usd_market_cap || t.market_cap_usd || t.marketCap || null,
      athUsd: t.ath_usd || t.ath || null,
      isMigrated: Boolean(t.migrated || t.complete || t.raydium_pool),
      reached300k: Boolean(t.reached_300k || (t.usd_market_cap >= 300000)),
    })).filter((t: DevToken) => t.mint);
    
  } catch (e) {
    console.error("[GMGN] fetch failed:", e);
    return [];
  }
}

async function fetchCreatorTokensPumpFun(creator: string, maxItems: number): Promise<DevToken[]> {
  if (!PUMPFUN_JWT) return [];
  const out: DevToken[] = [];
  for (let offset = 0; offset < maxItems; offset += 50) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch(
        `https://frontend-api-v3.pump.fun/coins/user-created-coins/${creator}?limit=50&offset=${offset}&includeNsfw=true`,
        {
          headers: {
            Authorization: `Bearer ${PUMPFUN_JWT}`,
            Accept: "application/json",
          },
          signal: ctrl.signal,
          cache: "no-store",
        },
      );
      clearTimeout(t);
      if (!r.ok) break;
      const json = await r.json();
      const items = Array.isArray(json) ? json : json.data || json.coins || json.items || [];
      for (const item of items as Array<Record<string, any>>) {
        const mint = item.mint || item.address || item.token_address;
        if (!mint) continue;
        out.push({
          mint,
          symbol: item.symbol || "",
          name: item.name || "",
          createdAt: item.created_timestamp
            ? Math.floor(item.created_timestamp / 1000)
            : item.created_at
              ? Math.floor(item.created_at / 1000)
              : null,
          marketCapUsd: item.usd_market_cap || item.market_cap_usd || item.marketCap || null,
          athUsd: item.ath_usd || item.ath || null,
          isMigrated: Boolean(item.complete || item.raydium_pool || item.migrated),
          reached300k: Boolean(item.reached_300k || (item.usd_market_cap >= 300_000)),
        });
      }
      if (items.length < 50 || out.length >= maxItems) break;
    } catch {
      break;
    }
  }
  return out.slice(0, maxItems);
}

async function solscanApi<T>(endpoint: string): Promise<T | null> {
  if (!SOLSCAN_API_TOKEN) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const r = await fetch(`https://api.solscan.io${endpoint}`, {
      headers: {
        Authorization: `Bearer ${SOLSCAN_API_TOKEN}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function solscanProApi<T>(endpoint: string): Promise<T | null> {
  if (!SOLSCAN_API_TOKEN) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const r = await fetch(`https://pro-api.solscan.io/v2.0${endpoint}`, {
      headers: {
        token: SOLSCAN_API_TOKEN,
        Accept: "application/json",
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function collectPumpMints(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}pump$/.test(value)) out.add(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPumpMints(item, out);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectPumpMints(item, out);
  }
}

async function fetchCreatorTokensRpc(creator: string, maxItems: number): Promise<DevToken[]> {
  const out: DevToken[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 40 && out.length < maxItems; page++) {
    let signatures: Array<{ signature: string; blockTime?: number }> = [];
    try {
      signatures = await rpc<Array<{ signature: string; blockTime?: number }>>("getSignaturesForAddress", [
        creator,
        { limit: 100, before },
      ]);
    } catch {
      break;
    }
    if (signatures.length === 0) break;
    for (const sig of signatures) {
      try {
        const tx = await rpc<any>("getParsedTransaction", [
          sig.signature,
          { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ]);
        const text = JSON.stringify(tx);
        if (!text.includes("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") && !text.includes("pump")) continue;
        const mints = new Set<string>();
        collectPumpMints(tx, mints);
        for (const mint of mints) {
          if (seen.has(mint)) continue;
          seen.add(mint);
          out.push({
            mint,
            symbol: "",
            name: "",
            createdAt: sig.blockTime ?? null,
            marketCapUsd: null,
            athUsd: null,
            isMigrated: false,
            reached300k: false,
          });
          if (out.length >= maxItems) break;
        }
      } catch {
        continue;
      }
      if (out.length >= maxItems) break;
    }
    before = signatures[signatures.length - 1]?.signature;
    if (!before || signatures.length < 100) break;
  }
  return out;
}

async function fetchCreatorTokensSolscan(creator: string, maxItems: number): Promise<DevToken[]> {
  const seen = new Set<string>();
  const out: DevToken[] = [];
  for (let offset = 0; offset < 2000 && out.length < maxItems; offset += 40) {
    const page = await solscanApi<{ success?: boolean; data?: Array<{ txHash?: string; blockTime?: number; status?: string }> }>(
      `/account/transactions?address=${creator}&limit=40&offset=${offset}`
    );
    const proPage = page?.data?.length ? null : await solscanProApi<{ success?: boolean; data?: Array<{ trans_id?: string; block_time?: number; status?: string }> }>(
      `/account/transactions?address=${creator}&limit=40&offset=${offset}`
    );
    const txs = [
      ...(page?.data ?? []),
      ...((proPage?.data ?? []).map((tx: { trans_id?: string; block_time?: number; status?: string }) => ({ txHash: tx.trans_id, blockTime: tx.block_time, status: tx.status }))),
    ];
    if (txs.length === 0) break;
    for (const tx of txs) {
      if (!tx.txHash || tx.status === "Fail") continue;
      const details = await solscanApi<unknown>(`/transaction?tx=${tx.txHash}`);
      const mints = new Set<string>();
      collectPumpMints(details, mints);
      for (const mint of mints) {
        if (seen.has(mint)) continue;
        seen.add(mint);
        out.push({
          mint,
          symbol: "",
          name: "",
          createdAt: tx.blockTime ?? null,
          marketCapUsd: null,
          athUsd: null,
          isMigrated: false,
          reached300k: false,
        });
        if (out.length >= maxItems) break;
      }
      if (out.length >= maxItems) break;
    }
    if (txs.length < 40) break;
  }
  return out;
}

/**
 * Fetch tokens created by a wallet via Helius Enhanced Transactions API.
 * Pump.fun frontend API is dead (Cloudflare DNS error 1016), so we paginate
 * the wallet's transaction history, filter source=PUMP_FUN, and collect unique mints.
 */
async function fetchPumpFunCreatedTokens(creator: string, maxItems: number): Promise<DevToken[]> {
  const seen = new Set<string>();
  const tokens: DevToken[] = [];
  const BATCH_SIZE = 10; // 10 parallel requests = 1000 txs per batch
  const MAX_BATCHES = 100; // 100 * 1000 = 100000 txs max for creators with huge history

  type TxItem = {
    signature: string;
    source: string;
    type: string;
    timestamp: number;
    tokenTransfers?: Array<{ mint: string; fromUserAccount: string; toUserAccount: string; tokenAmount: number }>;
  };

  // Helper to fetch a single page
  const fetchPage = async (before?: string): Promise<TxItem[]> => {
    let path = `/v0/addresses/${creator}/transactions?limit=100`;
    if (before) path += `&before=${before}`;
    try {
      return await heliusFetch<TxItem[]>(path);
    } catch {
      return [];
    }
  };

  let before: string | undefined;

  for (let batch = 0; batch < MAX_BATCHES && tokens.length < maxItems; batch++) {
    // First request of batch to get starting "before" for subsequent parallel requests
    const first = await fetchPage(before);
    if (!first || first.length === 0) break;

    // Prepare parallel requests for rest of batch
    const parallel: Promise<TxItem[]>[] = [];
    let cursor = first[first.length - 1]?.signature;
    for (let i = 1; i < BATCH_SIZE && cursor; i++) {
      parallel.push(fetchPage(cursor));
      // We don't know next cursor yet, will be determined after results
    }

    const rest = await Promise.all(parallel);
    const allPages = [first, ...rest];

    // Process all pages in this batch
    for (const page of allPages) {
      if (!page || page.length === 0) continue;
      for (const tx of page) {
        // Only PUMP_FUN source transactions indicate token creation/interaction with bonding curve
        if (tx.source !== "PUMP_FUN") continue;
        for (const tt of tx.tokenTransfers ?? []) {
          if (tt.mint === SOL_MINT || seen.has(tt.mint)) continue;
          // Accept all PUMP_FUN token transfers, not just 'pump' suffix
          seen.add(tt.mint);
          tokens.push({
            mint: tt.mint,
            symbol: "",
            name: "",
            createdAt: tx.timestamp,
            marketCapUsd: null,
            athUsd: null,
            isMigrated: false,
            reached300k: false,
          });
          if (tokens.length >= maxItems) break;
        }
        if (tokens.length >= maxItems) break;
      }
      if (tokens.length >= maxItems) break;
    }

    // Update cursor for next batch
    const lastPage = allPages[allPages.length - 1];
    if (!lastPage || lastPage.length < 100) break;
    before = lastPage[lastPage.length - 1]?.signature;
    if (!before) break;
  }

  // Post-filter: verify real creator via DAS for accuracy (limit to first 50 for performance)
  const verifiedTokens: DevToken[] = [];
  const checkLimit = Math.min(tokens.length, 50);
  
  for (let i = 0; i < checkLimit; i++) {
    const t = tokens[i];
    try {
      const asset = await rpc<{
        id: string;
        ownership?: { owner?: string };
        creators?: { address: string }[];
      }>("getAsset", { id: t.mint });
      
      // Check if our creator is in creators list or is owner
      const isRealCreator = asset.creators?.some(c => c.address === creator) || 
                           asset.ownership?.owner === creator;
      
      if (isRealCreator) {
        verifiedTokens.push(t);
      }
    } catch {
      // If check fails, include token (better to have false positive than miss)
      verifiedTokens.push(t);
    }
  }
  
  // Add remaining tokens without verification (performance trade-off)
  if (tokens.length > checkLimit) {
    verifiedTokens.push(...tokens.slice(checkLimit));
  }
  
  console.log(`[fetchPumpFunCreatedTokens] Found ${tokens.length} candidates, verified ${verifiedTokens.length} as real creator`);
  return verifiedTokens;
}

/**
 * Fallback: paginated DAS getAssetsByCreator (works for non-pump SPL tokens).
 */
async function fetchCreatorTokensDAS(creator: string, maxItems: number): Promise<DevToken[]> {
  const out: DevToken[] = [];
  let page = 1;
  const MAX_PAGES = 50; // Increase pagination depth
  console.log(`[fetchCreatorTokensDAS] Starting DAS lookup for creator ${creator}`);
  while (out.length < maxItems && page <= MAX_PAGES) {
    const result = await rpc<{
      items: {
        id: string;
        content?: { metadata?: { name?: string; symbol?: string } };
      }[];
    }>("getAssetsByCreator", {
      creatorAddress: creator,
      page,
      limit: 1000, // Increase limit per page
      onlyVerified: false,
    });
    const items = result.items ?? [];
    console.log(`[fetchCreatorTokensDAS] Page ${page}: ${items.length} items`);
    if (items.length === 0) break;
    for (const a of items) {
      out.push({
        mint: a.id,
        symbol: a.content?.metadata?.symbol ?? "",
        name: a.content?.metadata?.name ?? "",
        createdAt: null, marketCapUsd: null, athUsd: null,
        isMigrated: false, reached300k: false,
      });
    }
    if (items.length < 1000) break;
    page++;
  }
  console.log(`[fetchCreatorTokensDAS] Fetched ${out.length} tokens from DAS (${page} pages)`);
  return out.slice(0, maxItems);
}

/**
 * Fallback: scrape Pump.fun profile HTML for pump mints.
 * Authoritative source for all tokens created by a wallet on pump.fun.
 */
async function fetchCreatorTokensPumpProfile(creator: string, maxItems: number): Promise<DevToken[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const r = await fetch(`https://pump.fun/profile/${creator}`, {
      headers: { Accept: "text/html" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const html = await r.text();
    const mintRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}pump/g;
    const matches = html.match(mintRegex);
    if (!matches) return [];
    const uniqueMints = [...new Set(matches)];
    const tokens: DevToken[] = uniqueMints.slice(0, maxItems).map((mint) => ({
      mint,
      symbol: "",
      name: "",
      createdAt: null,
      marketCapUsd: null,
      athUsd: null,
      isMigrated: false,
      reached300k: false,
    }));
    console.log(`[fetchCreatorTokensPumpProfile] Scraped ${tokens.length} pump mints from profile`);
    return tokens;
  } catch (e) {
    console.error("[fetchCreatorTokensPumpProfile] Failed:", (e as Error).message);
    return [];
  }
}

function mergeTokens(...groups: DevToken[][]): DevToken[] {
  const byMint = new Map<string, DevToken>();
  for (const group of groups) {
    for (const token of group) {
      const existing = byMint.get(token.mint);
      if (!existing) {
        byMint.set(token.mint, token);
        continue;
      }
      byMint.set(token.mint, {
        mint: token.mint,
        symbol: existing.symbol || token.symbol,
        name: existing.name || token.name,
        createdAt: existing.createdAt ?? token.createdAt,
        marketCapUsd: existing.marketCapUsd ?? token.marketCapUsd,
        athUsd: existing.athUsd ?? token.athUsd,
        isMigrated: existing.isMigrated || token.isMigrated,
        reached300k: existing.reached300k || token.reached300k,
      });
    }
  }
  return [...byMint.values()];
}

/**
 * Primary entry. Source priority:
 *   1. Locally indexed dev_tokens table (populated by PumpPortal WebSocket — 100% accurate).
 *   2. Helius Enhanced Transactions filtered by source=PUMP_FUN.
 *   3. DAS getAssetsByCreator (non-pump SPL tokens).
 */
async function fetchCreatorTokens(creator: string, maxItems: number = 5000): Promise<DevToken[]> {
  console.log(`[fetchCreatorTokens] Starting token discovery for creator ${creator}`);
  let localTokens: DevToken[] = [];
  const groups: DevToken[][] = [];
  // 1. Local index (PumpPortal-fed). Accurate creator → mint mapping.
  try {
    const indexed = getDevTokensByCreator(creator, maxItems);
    if (indexed.length > 0) {
      console.log(`[fetchCreatorTokens] Local index returned ${indexed.length} tokens`);
      localTokens = indexed.map((r) => ({
        mint: r.mint,
        symbol: r.symbol ?? "",
        name: r.name ?? "",
        createdAt: r.createdAt ?? null,
        marketCapUsd: r.marketCapUsd ?? null,
        athUsd: r.athUsd ?? null,
        isMigrated: !!r.isMigrated,
        reached300k: !!r.reached300k,
      }));
      groups.push(localTokens);
    }
  } catch (e) {
    console.error("[fetchCreatorTokens] Local index lookup failed:", (e as Error).message);
  }

  console.log(`[fetchCreatorTokens] Calling fetchCreatorTokensPumpFun`);
  const pumpFunTokens = await fetchCreatorTokensPumpFun(creator, maxItems);
  if (pumpFunTokens.length > 0) {
    console.log(`[fetchCreatorTokens] Pump.fun returned ${pumpFunTokens.length} tokens`);
    groups.push(pumpFunTokens);
  }

  // 2. Helius with PUMP_FUN filter
  console.log(`[fetchCreatorTokens] Calling fetchPumpFunCreatedTokens`);
  const pumpTokens = await fetchPumpFunCreatedTokens(creator, maxItems);
  if (pumpTokens.length > 0) {
    console.log(`[fetchCreatorTokens] Helius returned ${pumpTokens.length} tokens (source=PUMP_FUN filtered)`);
    groups.push(pumpTokens);
  }

  console.log(`[fetchCreatorTokens] Calling fetchCreatorTokensRpc`);
  const rpcTokens = await fetchCreatorTokensRpc(creator, maxItems);
  if (rpcTokens.length > 0) {
    console.log(`[fetchCreatorTokens] RPC returned ${rpcTokens.length} pump tokens`);
    groups.push(rpcTokens);
  }

  console.log(`[fetchCreatorTokens] Calling fetchCreatorTokensSolscan`);
  const solscanTokens = await fetchCreatorTokensSolscan(creator, maxItems);
  if (solscanTokens.length > 0) {
    console.log(`[fetchCreatorTokens] Solscan returned ${solscanTokens.length} pump tokens`);
    groups.push(solscanTokens);
  }

  console.log(`[fetchCreatorTokens] Calling fetchCreatorTokensGMGN`);
  const gmgnTokens = await fetchCreatorTokensGMGN(creator);
  if (gmgnTokens.length > 0) {
    console.log(`[fetchCreatorTokens] GMGN returned ${gmgnTokens.length} tokens`);
    groups.push(gmgnTokens);
  }

  console.log(`[fetchCreatorTokens] Calling fetchCreatorTokensDAS`);
  const dasTokens = await fetchCreatorTokensDAS(creator, maxItems);
  if (dasTokens.length > 0) {
    console.log(`[fetchCreatorTokens] DAS returned ${dasTokens.length} tokens`);
    groups.push(dasTokens);
  }

  // Fallback: scrape Pump.fun profile HTML for pump mints (authoritative)
  console.log(`[fetchCreatorTokens] Calling fetchCreatorTokensPumpProfile`);
  const pumpProfileTokens = await fetchCreatorTokensPumpProfile(creator, maxItems);
  if (pumpProfileTokens.length > 0) {
    console.log(`[fetchCreatorTokens] PumpProfile returned ${pumpProfileTokens.length} tokens`);
    groups.push(pumpProfileTokens);
  }

  const merged = mergeTokens(...groups);
  console.log(`[fetchCreatorTokens] Merged ${merged.length} unique tokens from ${groups.length} sources`);
  return merged.slice(0, maxItems);
}

/**
 * Enrich tokens with DexScreener data (market cap, ATH proxy via FDV, migration status).
 */
async function enrichWithDexScreener(tokens: DevToken[]): Promise<DevToken[]> {
  // Skip tokens that already have MC + createdAt from pump.fun
  const needsEnrichment = tokens.filter((t) => t.marketCapUsd == null || t.createdAt == null);
  // DexScreener allows batch lookup up to 30 mints at a time
  const chunks: DevToken[][] = [];
  for (let i = 0; i < needsEnrichment.length; i += 30) chunks.push(needsEnrichment.slice(i, i + 30));

  for (const chunk of chunks) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((t) => t.mint).join(",")}`;
      const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!r.ok) continue;
      const json = (await r.json()) as { pairs?: Array<{ baseToken?: { address?: string }; marketCap?: number; fdv?: number; dexId?: string; pairCreatedAt?: number }> };
      const byMint = new Map<string, { mc?: number; fdv?: number; dexId?: string; pairCreatedAt?: number }>();
      for (const p of json.pairs ?? []) {
        const addr = p.baseToken?.address;
        if (!addr) continue;
        const existing = byMint.get(addr);
        // Prefer pump.fun pair for creation date, raydium pair for migration signal
        if (!existing || (p.marketCap ?? 0) > (existing.mc ?? 0)) {
          byMint.set(addr, { mc: p.marketCap, fdv: p.fdv, dexId: p.dexId, pairCreatedAt: p.pairCreatedAt });
        }
      }
      for (const t of chunk) {
        const info = byMint.get(t.mint);
        if (!info) continue;
        t.marketCapUsd = info.mc ?? info.fdv ?? null;
        // Migration heuristic: presence of a non-pumpfun DEX pair (raydium, meteora, etc.)
        // For full accuracy we'd check all pairs per mint, but single-pair-per-mint is a fast proxy.
        t.isMigrated = info.dexId !== "pumpfun" && info.dexId != null;
        t.reached300k = (t.marketCapUsd ?? 0) >= 300_000;
        if (info.pairCreatedAt) t.createdAt = Math.floor(info.pairCreatedAt / 1000);
      }
    } catch {
      // ignore chunk failures
    }
  }
  return tokens;
}

/**
 * Compute best launch hour (UTC) — the hour with highest average MC across this dev's tokens.
 */
function computeBestLaunchHour(tokens: DevToken[]): { bestHour: number | null; byHour: number[] } {
  const sumByHour = new Array<number>(24).fill(0);
  const countByHour = new Array<number>(24).fill(0);
  for (const t of tokens) {
    if (!t.createdAt) continue;
    const hour = new Date(t.createdAt * 1000).getUTCHours();
    countByHour[hour]++;
    sumByHour[hour] += t.marketCapUsd ?? 0;
  }
  let bestHour: number | null = null;
  let bestAvg = -1;
  const avgByHour = sumByHour.map((s, i) => (countByHour[i] > 0 ? s / countByHour[i] : 0));
  for (let h = 0; h < 24; h++) {
    if (countByHour[h] >= 2 && avgByHour[h] > bestAvg) {
      bestAvg = avgByHour[h];
      bestHour = h;
    }
  }
  return { bestHour, byHour: countByHour };
}

// ── Risk metrics ──────────────────────────────────────────────────────────
const RUG_MC_THRESHOLD_USD = 5_000;     // tokens with MC < $5K considered "dead/rugged"
const SUCCESS_MC_THRESHOLD_USD = 300_000;

function getTokenAthMcUsd(token: DevToken): number {
  const ath = token.athUsd ?? 0;
  const current = token.marketCapUsd ?? 0;
  return Math.max(ath, current, 0);
}

function computeRiskMetrics(tokens: DevToken[]) {
  const total = tokens.length;
  if (total === 0) {
    return {
      riskScore: 0,
      riskLevel: "low" as const,
      riskReasons: ["Нет данных по созданным токенам"],
      rugRate: 0,
      successRate: 0,
      avgMcUsd: null as number | null,
      medianMcUsd: null as number | null,
      maxMcUsd: null as number | null,
      minTimeBetweenLaunchesSec: null as number | null,
      avgTimeBetweenLaunchesSec: null as number | null,
      daysSinceLastLaunch: null as number | null,
      bestToken: null as { mint: string; symbol: string; mcUsd: number } | null,
      worstToken: null as { mint: string; symbol: string; mcUsd: number } | null,
    };
  }

  // ATH MC stats
  const mcs = tokens.map(getTokenAthMcUsd);
  const positiveMcs = mcs.filter((v) => v > 0).sort((a, b) => a - b);
  const avgMcUsd = positiveMcs.length > 0
    ? positiveMcs.reduce((a, b) => a + b, 0) / positiveMcs.length
    : null;
  const medianMcUsd = positiveMcs.length > 0
    ? positiveMcs[Math.floor(positiveMcs.length / 2)]
    : null;
  const maxMcUsd = positiveMcs.length > 0 ? positiveMcs[positiveMcs.length - 1] : null;

  // Rug rate — tokens with MC below threshold (or zero) but excluding completely uninfo'd
  const rugCount = tokens.filter((t) => (t.marketCapUsd ?? 0) > 0 && (t.marketCapUsd ?? 0) < RUG_MC_THRESHOLD_USD).length;
  const knownMcCount = tokens.filter((t) => (t.marketCapUsd ?? 0) > 0).length;
  const rugRate = knownMcCount > 0 ? rugCount / knownMcCount : 0;

  // Success rate by ATH MC
  const successCount = tokens.filter((t) => getTokenAthMcUsd(t) >= SUCCESS_MC_THRESHOLD_USD).length;
  const successRate = total > 0 ? successCount / total : 0;

  // Launch cadence
  const ts = tokens
    .map((t) => t.createdAt)
    .filter((v): v is number => typeof v === "number" && v > 0)
    .sort((a, b) => a - b);
  let minDiff: number | null = null;
  let avgDiff: number | null = null;
  let daysSinceLast: number | null = null;
  if (ts.length >= 2) {
    let sum = 0;
    let mn = Infinity;
    for (let i = 1; i < ts.length; i++) {
      const d = ts[i] - ts[i - 1];
      sum += d;
      if (d < mn) mn = d;
    }
    avgDiff = Math.floor(sum / (ts.length - 1));
    minDiff = mn === Infinity ? null : mn;
  }
  if (ts.length >= 1) {
    daysSinceLast = Math.floor((Date.now() / 1000 - ts[ts.length - 1]) / 86400);
  }

  // Best / worst tokens
  let best: { mint: string; symbol: string; mcUsd: number } | null = null;
  let worst: { mint: string; symbol: string; mcUsd: number } | null = null;
  for (const t of tokens) {
    const mc = getTokenAthMcUsd(t);
    if (mc <= 0) continue;
    if (!best || mc > best.mcUsd) best = { mint: t.mint, symbol: t.symbol, mcUsd: mc };
    if (!worst || mc < worst.mcUsd) worst = { mint: t.mint, symbol: t.symbol, mcUsd: mc };
  }

  // ── Risk score (0–100) ─────────────────────────────────────────────────
  let score = 0;
  const reasons: string[] = [];

  if (rugRate >= 0.8) { score += 40; reasons.push(`${(rugRate * 100).toFixed(0)}% токенов скамнули (<$5K MC)`); }
  else if (rugRate >= 0.6) { score += 25; reasons.push(`${(rugRate * 100).toFixed(0)}% токенов мертвы`); }
  else if (rugRate >= 0.4) { score += 10; reasons.push(`Высокий процент мертвых токенов (${(rugRate * 100).toFixed(0)}%)`); }

  if (successRate < 0.05 && total >= 5) { score += 20; reasons.push(`Меньше 5% токенов достигли $300K`); }
  else if (successRate < 0.15 && total >= 5) { score += 10; reasons.push(`Низкий success rate (${(successRate * 100).toFixed(0)}%)`); }

  if (minDiff !== null && minDiff < 60 * 60) { // < 1 час между запусками
    score += 20;
    reasons.push(`Сериальный фарм: минимум ${Math.floor(minDiff / 60)}мин между запусками`);
  } else if (minDiff !== null && minDiff < 6 * 60 * 60) {
    score += 8;
    reasons.push(`Частые запуски (мин ${Math.floor(minDiff / 3600)}ч между токенами)`);
  }

  if (total >= 50) { score += 10; reasons.push(`${total} запусков — массовый минтер`); }
  else if (total >= 20) { score += 5; reasons.push(`${total} запусков — частый минтер`); }

  if (avgMcUsd !== null && avgMcUsd < 10_000 && total >= 5) {
    score += 10;
    reasons.push(`Средний MC всего $${avgMcUsd.toFixed(0)}`);
  }

  // Positive signals reduce score
  if (successRate >= 0.3) { score = Math.max(0, score - 15); reasons.push(`Хороший успех: ${(successRate * 100).toFixed(0)}% токенов >$300K`); }
  if (maxMcUsd !== null && maxMcUsd >= 1_000_000) { score = Math.max(0, score - 5); reasons.push(`Лучший токен достиг $${(maxMcUsd / 1_000_000).toFixed(1)}M MC`); }

  score = Math.min(100, Math.max(0, score));
  const level: "low" | "medium" | "high" | "critical" =
    score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low";

  if (reasons.length === 0) reasons.push("Недостаточно данных для оценки риска");

  return {
    riskScore: score,
    riskLevel: level,
    riskReasons: reasons,
    rugRate,
    successRate,
    avgMcUsd,
    medianMcUsd,
    maxMcUsd,
    minTimeBetweenLaunchesSec: minDiff,
    avgTimeBetweenLaunchesSec: avgDiff,
    daysSinceLastLaunch: daysSinceLast,
    bestToken: best,
    worstToken: worst,
  };
}

const DEV_REFRESH_MS = 30 * 60_000; // re-fetch from pump.fun every 30min
const DEV_ANALYSIS_CACHE_VERSION = "v4-ath-mc";

export async function analyzeDev(creator: string, opts: { maxTokens?: number; skipCache?: boolean } = {}): Promise<DevAnalysis> {
  const maxTokens = opts.maxTokens ?? 5000;

  // 1. In-memory TTL cache (30min)
  const cacheKey = `${DEV_ANALYSIS_CACHE_VERSION}:${creator}`;
  if (!opts.skipCache) {
    const cached = getCache<DevAnalysis>("dev_tokens_cache", cacheKey);
    if (cached) return cached;
  }

  // 2. Persistent DB fast path — if we have a fresh DB entry skip pump.fun API entirely
  if (!opts.skipCache) {
    const dbWallet = getDevWallet(creator);
    if (dbWallet && dbWallet.totalTokens > 1 && Date.now() - dbWallet.lastUpdatedAt < DEV_REFRESH_MS) {
      const dbTokens = getDevTokensByCreator(creator, maxTokens);
      if (dbTokens.length > 0 && dbTokens.length >= dbWallet.totalTokens) {
        const tokens: DevToken[] = dbTokens.map((t) => ({
          mint: t.mint,
          symbol: t.symbol ?? "",
          name: t.name ?? "",
          createdAt: t.createdAt,
          marketCapUsd: t.marketCapUsd,
          athUsd: t.athUsd,
          isMigrated: t.isMigrated,
          reached300k: t.reached300k,
        }));
        const { bestHour, byHour } = computeBestLaunchHour(tokens);
        const risk = computeRiskMetrics(tokens);
        const result: DevAnalysis = {
          address: creator,
          totalTokensCreated: dbWallet.totalTokens,
          tokens,
          migratedCount: dbWallet.migratedCount,
          migrationRate: dbWallet.migrationRate,
          reached300kCount: dbWallet.reached300kCount,
          rate300k: dbWallet.rate300k,
          bestLaunchHourUtc: bestHour,
          launchesByHour: byHour,
          fetchedAt: dbWallet.lastUpdatedAt,
          ...risk,
        };
        setCache("dev_tokens_cache", cacheKey, result, DEV_REFRESH_MS);
        return result;
      }
    }
  }

  // 3. Fetch from pump.fun API
  const tokens = await fetchCreatorTokens(creator, maxTokens);
  await enrichWithDexScreener(tokens);

  const migrated = tokens.filter((t) => t.isMigrated);
  const reached300k = tokens.filter((t) => t.reached300k);
  const { bestHour, byHour } = computeBestLaunchHour(tokens);

  const risk = computeRiskMetrics(tokens);

  const result: DevAnalysis = {
    address: creator,
    totalTokensCreated: tokens.length,
    tokens,
    migratedCount: migrated.length,
    migrationRate: tokens.length > 0 ? migrated.length / tokens.length : 0,
    reached300kCount: reached300k.length,
    rate300k: tokens.length > 0 ? reached300k.length / tokens.length : 0,
    bestLaunchHourUtc: bestHour,
    launchesByHour: byHour,
    fetchedAt: Date.now(),
    ...risk,
  };

  // 4. Persist to DB (non-blocking — failures don't affect response)
  try {
    persistDevWallet({
      address: creator,
      totalTokens: tokens.length,
      migratedCount: migrated.length,
      migrationRate: result.migrationRate,
      reached300kCount: reached300k.length,
      rate300k: result.rate300k,
      bestLaunchHour: bestHour,
      totalVolumeSol: 0, // enriched separately when trade analysis runs
      totalFeesSol: 0,
      avgMcUsd: risk.avgMcUsd,
      maxMcUsd: risk.maxMcUsd,
      source: "pumpfun",
      lastUpdatedAt: Date.now(),
    });
    persistDevTokens(tokens.map((t): DevTokenRow => ({
      mint: t.mint,
      creator,
      symbol: t.symbol || null,
      name: t.name || null,
      image: null, // enriched by token-info endpoint
      description: null,
      twitter: null,
      telegram: null,
      website: null,
      createdAt: t.createdAt,
      marketCapUsd: t.marketCapUsd,
      athUsd: t.athUsd,
      isMigrated: t.isMigrated,
      reached300k: t.reached300k,
      totalSupply: 1_000_000_000,
      source: "pumpfun",
      lastUpdatedAt: Date.now(),
    })));
  } catch (e) {
    console.error("[analyzeDev] DB persist failed:", e);
  }

  setCache("dev_tokens_cache", cacheKey, result, DEV_REFRESH_MS);
  return result;
}
