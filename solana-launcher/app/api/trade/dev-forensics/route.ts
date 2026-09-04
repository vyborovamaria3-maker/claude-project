// data-tag: api.trade.dev_forensics
// GET /api/trade/dev-forensics?creator=...&mint=...
// Returns: total/created/migrated tokens, avg lifespan, Solana volume correlation, detailed analytics

import { NextRequest, NextResponse } from "next/server";
import { analyzePumpFunCreatorFee } from "../../../../lib/trade/creator-fee-agent";
import { getCachedTokenVolume, upsertDevTokenVolume } from "../../../../lib/trade/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE: Map<string, { data: ForensicsResult; ts: number }> = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 min
const ATH_CACHE_VERSION = "ath-v14";

// Solscan API token
const SOLSCAN_API_TOKEN = process.env.SOLSCAN_API_TOKEN || "";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("operation timed out")), ms)),
  ]);
}

function forwardedAuthHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = req.headers.get("authorization");
  const cookie = req.headers.get("cookie");
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export interface TokenForensics {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number | null;
  lastActiveAt: number | null;
  lifespanHours: number | null;
  lifespanMinutes: number | null;
  networkVolumeMAt_launch: number | null; // Solana DEX volume in $M on launch day
  pumpFunVolumeMAt_launch: number | null; // Pump.fun volume in $M on launch day
  tokenVolumeSol: number | null;
  tokenVolumeUsd: number | null;
  isMigrated: boolean;
  athUsd: number | null;
  peakMarketCap: number | null;
  historicalPeakMCAP?: number | null;
  creatorFeesUsd: number | null;
  totalFeesSol: number | null;
  totalFeesUsd: number | null;
  migrationMarketCap: number | null;
  migrationTimestamp: number | null;
  twitter?: {
    handle: string | null;
    followers: number | null;
    postsCount: number | null;
    avgViews: number | null;
    avgLikes: number | null;
    avgRetweets: number | null;
    botScore: number | null;
  };
}

export interface ForensicsResult {
  creator: string;
  totalCreatedTokens: number;
  totalMigratedTokens: number;
  migrationRate: number; // percentage
  avgLifespanHours: number | null;
  medianLifespanHours: number | null;
  avgLifespanMinutes: number | null;
  medianLifespanMinutes: number | null;
  averageTokenVolumeUsd: number;
  averageCreatorFeesUsd: number;
  resolvedTokenVolumeUsdTotal: number;
  resolvedCreatorFeesUsdTotal: number;
  resolvedTokenVolumeCount: number;
  resolvedCreatorFeesCount: number;
  tokens: TokenForensics[];
  volumeCorrelation: VolumeCorrelationBin[];
  optimalVolumeRangeM: { min: number; max: number } | null;
  currentNetworkVolumeM: number | null;
  isOptimalLaunchTime: boolean;
  bestToken: TokenForensics | null;
  worstToken: TokenForensics | null;
  successRate: number; // tokens reaching $100k MC
  lifetimeDistribution: {
    under5m: number;
    from5mTo30m: number;
    from30mTo2h: number;
    from2hTo24h: number;
    over24h: number;
  };
  summary: string;
  lastUpdated: number;
}

export interface VolumeCorrelationBin {
  label: string;
  minM: number;
  maxM: number;
  tokenCount: number;
  migrationRate: number;
  avgAthUsd: number;
}

type DevTokenListItem = {
  mint: string;
  symbol: string;
  name?: string | null;
  createdAt?: number | null;
  marketCapUsd?: number | null;
  athUsd?: number | null;
  isMigrated?: boolean | null;
};

type SolscanTokenResponse = {
  success?: boolean;
  data?: {
    symbol?: string;
    name?: string;
    creator?: string;
    createTime?: string | number;
    marketCapUsd?: number;
    liquidityUsd?: number;
    holderCount?: number;
  };
};

type SolscanTransactionListResponse = {
  success?: boolean;
  data?: Array<{
    txHash?: string;
    status?: string;
    blockTime?: number;
  }>;
};

type SolscanTransactionResponse = {
  success?: boolean;
  data?: {
    parsedInstruction?: Array<{
      programId?: string;
      type?: string;
      accounts?: Array<{ isSigner?: boolean; account?: string }>;
    }>;
    instructions?: Array<{
      programId?: string;
      parsed?: { type?: string };
      accounts?: Array<{ isSigner?: boolean; account?: string }>;
    }>;
  };
};

type SolscanTransferResponse = {
  success?: boolean;
  data?: Array<{
    src?: string;
  }>;
};

type DexScreenerPair = {
  dexId?: string;
  fdv?: number;
  priceUsd?: string;
  pairCreatedAt?: number;
  baseToken?: { symbol?: string; name?: string };
  info?: {
    socials?: Array<{ type?: string; url?: string }> | Record<string, string | undefined>;
    websites?: Array<{ url?: string } | string>;
  };
  priceChange?: Record<string, number>;
  volume?: {
    h24?: number;
    h6?: number;
    h1?: number;
    m5?: number;
  };
  liquidity?: {
    usd?: number;
  };
};

type DexScreenerResponse = {
  pairs?: DexScreenerPair[];
};

type PumpFunCoinResponse = {
  symbol?: string;
  name?: string;
  created_at?: string | number;
  created_timestamp?: number;
  market_cap?: number;
  usd_market_cap?: number;
  ath?: number;
  ath_market_cap?: number;
  complete?: boolean;
  twitter?: string;
  telegram?: string;
  website?: string;
  creator?: string;
};

type PumpFunCandle = {
  high?: string | number;
  close?: string | number;
};

type LlamaOverviewResponse = {
  totalDataChart?: [number, number][];
};

type PumpTradeResponse = {
  trades?: Array<{ userAddress?: string }>;
};

function getDexSocialUrl(
  socials: Array<{ type?: string; url?: string }> | Record<string, string | undefined> | undefined,
  type: string,
): string | undefined {
  if (Array.isArray(socials)) {
    return socials.find((item) => item.type === type)?.url;
  }
  return socials?.[type];
}

function getDexWebsiteUrl(websites: Array<{ url?: string } | string> | undefined): string | undefined {
  if (!Array.isArray(websites)) return undefined;
  const first = websites[0];
  return typeof first === "string" ? first : first?.url;
}

function asFinitePositiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isPlausibleMcapAth(value: number | null): value is number {
  return value !== null && value >= 1_000 && value < 10_000_000_000;
}

function resolveMetadataAth(tokenInfo: { ath?: number; marketCap?: number }): number | null {
  const ath = asFinitePositiveNumber(tokenInfo.ath);
  if (isPlausibleMcapAth(ath)) return ath;
  return null;
}

async function resolveCandleMcapAth(mint: string, currentMarketCap: number | null, currentDexPrice: number): Promise<number | null> {
  try {
    const candleRes = await fetch(`https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=1m&limit=1000`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });

    if (!candleRes.ok) return null;

    const candleData = await candleRes.json();
    if (!Array.isArray(candleData) || candleData.length === 0) return null;

    let maxHigh = 0;
    for (const candle of candleData as PumpFunCandle[]) {
      const high = asFinitePositiveNumber(candle.high);
      if (high && high > maxHigh) maxHigh = high;
    }

    if (maxHigh <= 0) return null;

    if (maxHigh >= 1_000) return maxHigh;
    if (currentMarketCap && currentDexPrice > 0) {
      const derived = currentMarketCap * (maxHigh / currentDexPrice);
      return isPlausibleMcapAth(derived) ? derived : null;
    }

    const derivedFromSupply = maxHigh * 1_000_000_000;
    return isPlausibleMcapAth(derivedFromSupply) ? derivedFromSupply : null;
  } catch {
    return null;
  }
}

async function resolveTokenMcapAth(
  mint: string,
  tokenInfo: { ath?: number; marketCap?: number },
  currentMarketCap: number | null,
  currentDexPrice: number,
): Promise<number> {
  const candidates: number[] = [];

  const metadataAth = resolveMetadataAth(tokenInfo);
  if (metadataAth) candidates.push(metadataAth);

  const candleAth = await resolveCandleMcapAth(mint, currentMarketCap, currentDexPrice);
  if (candleAth) candidates.push(candleAth);

  const current = asFinitePositiveNumber(currentMarketCap);
  if (current) candidates.push(current);

  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

// Solscan API helper
async function solscanApi<T>(endpoint: string): Promise<T | null> {
  if (!SOLSCAN_API_TOKEN) return null;
  try {
    const r = await fetch(`https://api.solscan.io${endpoint}`, {
      headers: {
        "Authorization": `Bearer ${SOLSCAN_API_TOKEN}`,
        "Accept": "application/json"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) return null;
    const data = await r.json();
    return data as T;
  } catch {
    return null;
  }
}

// Get token info from Solscan
async function getSolscanTokenInfo(mint: string): Promise<{
  symbol: string;
  name: string;
  creator: string;
  createdAt: number;
  marketCap?: number;
  liquidity?: number;
  holderCount?: number;
} | null> {
  try {
    const data = await solscanApi<SolscanTokenResponse>(`/token?address=${mint}`);
    if (!data || !data.success || !data.data) return null;

    const token = data.data;
    const createdAt = token.createTime ? new Date(token.createTime).getTime() : Date.now();
    return {
      symbol: token.symbol || "",
      name: token.name || "",
      creator: token.creator || "",
      createdAt,
      marketCap: token.marketCapUsd || undefined,
      liquidity: token.liquidityUsd || undefined,
      holderCount: token.holderCount || undefined,
    };
  } catch {
    return null;
  }
}

// Get account transactions to find creator
async function getSolscanCreatorFromTx(mint: string): Promise<string | null> {
  try {
    const data = await solscanApi<SolscanTransactionListResponse>(`/account/transactions?address=${mint}&limit=20`);
    if (!data || !data.success || !data.data || data.data.length === 0) return null;

    for (const tx of data.data) {
      if (tx.txHash && tx.status === "Success" && tx.blockTime) {
        const txDetails = await solscanApi<SolscanTransactionResponse>(`/transaction?tx=${tx.txHash}`);
        if (txDetails?.success && txDetails.data?.parsedInstruction) {
          for (const inst of txDetails.data.parsedInstruction) {
            if (inst.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
                (inst.type === "initializeMint" || inst.type === "createMint")) {
              if (inst.accounts?.[0]?.isSigner && inst.accounts[0].account) {
                return inst.accounts[0].account;
              }
              for (const account of inst.accounts || []) {
                if (account.isSigner && account.account && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account.account)) {
                  return account.account;
                }
              }
            }
          }

          if (txDetails.data?.instructions) {
            for (const inst of txDetails.data.instructions) {
              if (inst.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
                  inst.parsed?.type === "initializeMint") {
                const signer = inst.accounts?.find((acc) => acc.isSigner);
                if (signer?.account && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signer.account)) {
                  return signer.account;
                }
              }
            }
          }
        }
        break;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function getPumpFunTokenInfo(mint: string): Promise<{
  symbol: string;
  name: string;
  createdAt: number;
  marketCap?: number;
  ath?: number;
  complete?: boolean;
  twitter?: string;
  telegram?: string;
  website?: string;
  creator?: string;
} | null> {
  try {
    const solscanInfo = await getSolscanTokenInfo(mint);
    if (solscanInfo) {
      let isMigrated = false;
      try {
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (dexRes.ok) {
          const dexData = (await dexRes.json()) as DexScreenerResponse;
          const pair = dexData.pairs?.[0];
          isMigrated = pair ? pair.dexId !== "pumpfun" : false;
        }
      } catch {
        // ignore
      }

      return {
        symbol: solscanInfo.symbol,
        name: solscanInfo.name,
        createdAt: solscanInfo.createdAt,
        marketCap: solscanInfo.marketCap,
        ath: undefined,
        complete: isMigrated,
        creator: solscanInfo.creator,
        twitter: undefined,
        telegram: undefined,
        website: undefined,
      };
    }
  } catch {
    // continue to DexScreener
  }

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as DexScreenerResponse;
      const pair = data.pairs?.[0];
      if (pair) {
        return {
          symbol: pair.baseToken?.symbol || "",
          name: pair.baseToken?.name || "",
          createdAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).getTime() : Date.now() - 24 * 60 * 60 * 1000,
          marketCap: pair.fdv || undefined,
          ath: undefined,
          complete: pair.dexId !== "pumpfun",
          twitter: getDexSocialUrl(pair.info?.socials, "twitter"),
          telegram: getDexSocialUrl(pair.info?.socials, "telegram"),
          website: getDexWebsiteUrl(pair.info?.websites),
        };
      }
    }
  } catch {
    // continue to pump.fun
  }

  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Origin": "https://pump.fun",
        "Referer": "https://pump.fun/"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PumpFunCoinResponse;
    const createdAt = data.created_timestamp
      ? data.created_timestamp
      : data.created_at
        ? new Date(data.created_at).getTime()
        : Date.now();
    return {
      symbol: data.symbol || "",
      name: data.name || "",
      createdAt,
      marketCap: data.usd_market_cap || data.market_cap || undefined,
      ath: data.ath_market_cap || data.ath || undefined,
      complete: data.complete || false,
      twitter: data.twitter || undefined,
      telegram: data.telegram || undefined,
      website: data.website || undefined,
    };
  } catch {
    return null;
  }
}

async function getPumpFunVolumeForDate(dateTs: number): Promise<number | null> {
  try {
    const url = `https://api.llama.fi/overview/dexs/pump-fun?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json()) as LlamaOverviewResponse;
    const chart: [number, number][] = data.totalDataChart || [];
    if (!chart.length) return null;

    let closest: number | null = null;
    let minDiff = Infinity;
    const targetSec = Math.floor(dateTs / 1000);

    for (const [ts, vol] of chart) {
      const diff = Math.abs(ts - targetSec);
      if (diff < minDiff) {
        minDiff = diff;
        closest = vol;
      }
    }

    return closest ? closest / 1_000_000 : null;
  } catch {
    return null;
  }
}

async function fetchSolanaVolumeForDate(dateTs: number): Promise<number | null> {
  try {
    const url = `https://api.llama.fi/overview/dexs/solana?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json()) as LlamaOverviewResponse;

    const chart: [number, number][] = data.totalDataChart || [];
    if (!chart.length) return null;

    let closest: number | null = null;
    let minDiff = Infinity;
    const targetSec = Math.floor(dateTs / 1000);

    for (const [ts, vol] of chart) {
      const diff = Math.abs(ts - targetSec);
      if (diff < minDiff) {
        minDiff = diff;
        closest = vol;
      }
    }

    return closest ? closest / 1_000_000 : null;
  } catch {
    return null;
  }
}

async function fetchCurrentSolanaVolume(): Promise<number | null> {
  try {
    const r = await fetch(
      "https://api.llama.fi/overview/dexs/solana?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume",
      { signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!r.ok) return null;
    const data = (await r.json()) as LlamaOverviewResponse;
    const chart: [number, number][] = data.totalDataChart || [];
    if (!chart.length) return null;
    const last = chart[chart.length - 1];
    return last ? last[1] / 1_000_000 : null;
  } catch {
    return null;
  }
}

async function analyzeToken(
  mint: string,
  options: {
    includeLaunchVolumes?: boolean;
    includeTwitter?: boolean;
    authHeaders?: Record<string, string>;
  } = {},
): Promise<TokenForensics | null> {
  try {
    const tokenInfo = await getPumpFunTokenInfo(mint);
    if (!tokenInfo) return null;

    let currentMarketCap = tokenInfo.marketCap || null;
    let isMigrated = tokenInfo.complete || false;
    const migrationMarketCap = null;
    const migrationTimestamp = null;
    let historicalPeakMCAP = currentMarketCap || 0;
    let currentDexPrice = 0;

    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (dexRes.ok) {
        const dexData = (await dexRes.json()) as DexScreenerResponse;
        const dexPair = dexData.pairs?.[0] || null;
        if (dexPair) {
          currentMarketCap = dexPair.fdv || currentMarketCap;
          currentDexPrice = parseFloat(dexPair.priceUsd || "0") || 0;
          isMigrated = dexPair.dexId !== "pumpfun" || !!tokenInfo.complete;
        }
      }
    } catch {
      // Use pump.fun data as fallback
    }

    historicalPeakMCAP = await resolveTokenMcapAth(mint, tokenInfo, currentMarketCap, currentDexPrice);

    const now = Date.now();
    const createdAt = tokenInfo.createdAt;
    const lastActiveAt = now;

    let lifespanMs = null;
    let lifespanMinutes = null;
    let lifespanHours = null;

    if (historicalPeakMCAP > 10000) {
      if (isMigrated) {
        lifespanMs = 3.5 * 60 * 60 * 1000;
      } else if (createdAt) {
        const actualTimeMs = now - createdAt;
        lifespanMs = Math.min(actualTimeMs, 4 * 60 * 60 * 1000);
      }

      if (lifespanMs) {
        lifespanMinutes = lifespanMs / (1000 * 60);
        lifespanHours = lifespanMs / (1000 * 60 * 60);
      }
    }

    const networkVolumeMAt_launch = options.includeLaunchVolumes && createdAt
      ? await fetchSolanaVolumeForDate(createdAt)
      : null;
    const pumpFunVolumeMAt_launch = options.includeLaunchVolumes && createdAt
      ? await getPumpFunVolumeForDate(createdAt)
      : null;

    let creatorFeesUsd: number | null = null;
    let tokenVolumeSol: number | null = null;
    let tokenVolumeUsd: number | null = null;
    let totalFeesSol: number | null = null;
    let totalFeesUsd: number | null = null;
    try {
      const feeReport = await withTimeout(analyzePumpFunCreatorFee({
        mint,
        isMigratedToRaydium: isMigrated,
        maxTrades: options.includeLaunchVolumes ? 300 : 80,
        skipSupplyRpc: true,
      }), options.includeLaunchVolumes ? 30000 : 6000);
      creatorFeesUsd = feeReport.totalCreatorFeesUsd;
      tokenVolumeSol = feeReport.tradingVolume.totalSol;
      tokenVolumeUsd = feeReport.tradingVolume.totalUsd;
      totalFeesSol = feeReport.totalFeesSol;
      totalFeesUsd = feeReport.totalFeesUsd;
    } catch {
      creatorFeesUsd = null;
      tokenVolumeSol = null;
      tokenVolumeUsd = null;
      totalFeesSol = null;
      totalFeesUsd = null;
    }

    let twitterData: TokenForensics["twitter"] = undefined;
    if (options.includeTwitter && tokenInfo.twitter) {
      try {
        const twitterRes = await fetch(
          `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/trade/dev-twitter?mint=${encodeURIComponent(mint)}`,
          {
            headers: options.authHeaders,
            cache: "no-store",
            signal: AbortSignal.timeout(30000),
          },
        );
        if (twitterRes.ok) {
          const twitterStats = await twitterRes.json();
          twitterData = {
            handle: tokenInfo.twitter,
            followers: twitterStats.tokenAccount?.followers || null,
            postsCount: twitterStats.tokenAccount?.postsCount || null,
            avgViews: twitterStats.avgViews || null,
            avgLikes: twitterStats.avgLikes || null,
            avgRetweets: twitterStats.avgRetweets || null,
            botScore: twitterStats.botRiskScore || null,
          };
        }
      } catch {
        // Twitter fetch failed, leave undefined
      }
    }

    return {
      mint,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      createdAt,
      lastActiveAt,
      lifespanHours,
      lifespanMinutes,
      networkVolumeMAt_launch,
      pumpFunVolumeMAt_launch,
      tokenVolumeSol,
      tokenVolumeUsd,
      isMigrated,
      athUsd: historicalPeakMCAP || tokenInfo.ath || null,
      peakMarketCap: currentMarketCap,
      historicalPeakMCAP,
      creatorFeesUsd,
      totalFeesSol,
      totalFeesUsd,
      migrationMarketCap,
      migrationTimestamp,
      twitter: twitterData || (tokenInfo.twitter ? {
        handle: tokenInfo.twitter,
        followers: null,
        postsCount: null,
        avgViews: null,
        avgLikes: null,
        avgRetweets: null,
        botScore: null,
      } : undefined),
    };
  } catch {
    return null;
  }
}

async function analyzeTokenMetricsLite(
  mint: string,
  creator: string,
): Promise<Pick<TokenForensics, "tokenVolumeSol" | "tokenVolumeUsd"> | null> {
  const cached = getCachedTokenVolume(mint);
  if (cached) {
    return {
      tokenVolumeSol: cached.tokenVolumeSol,
      tokenVolumeUsd: cached.tokenVolumeUsd,
    };
  }

  let result: { tokenVolumeSol: number | null; tokenVolumeUsd: number | null } | null = null;

  try {
    const res = await fetch(`https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=15m&limit=1000`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const candles = (await res.json()) as any[];
      if (candles && candles.length > 0) {
        let totalVolumeUsd = 0;
        let totalVolumeSol = 0;
        for (const candle of candles) {
          const close = Number(candle.close) || 0;
          const volume = Number(candle.volume) || 0;
          if (close < 0.0001) {
            totalVolumeUsd += volume;
          } else {
            totalVolumeUsd += volume * close;
            totalVolumeSol += volume;
          }
        }
        if (totalVolumeUsd > 0) {
          result = {
            tokenVolumeSol: totalVolumeSol > 0 ? totalVolumeSol : null,
            tokenVolumeUsd: totalVolumeUsd,
          };
        }
      }
    }
  } catch {
    // Continue to fallback
  }

  if (!result) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as DexScreenerResponse;
        const pair = data.pairs?.[0];
        const volumeUsd = pair?.volume?.h24 ?? null;
        if (volumeUsd != null && volumeUsd > 0) {
          result = {
            tokenVolumeSol: null,
            tokenVolumeUsd: volumeUsd,
          };
        }
      }
    } catch {
      // Ignore errors
    }
  }

  if (result && result.tokenVolumeUsd !== null) {
    upsertDevTokenVolume(mint, creator, result.tokenVolumeSol, result.tokenVolumeUsd);
  }

  return result;
}

function calculateLifetimeDistribution(tokens: TokenForensics[]): {
  under5m: number;
  from5mTo30m: number;
  from30mTo2h: number;
  from2hTo24h: number;
  over24h: number;
} {
  const distribution = {
    under5m: 0,
    from5mTo30m: 0,
    from30mTo2h: 0,
    from2hTo24h: 0,
    over24h: 0,
  };

  for (const token of tokens) {
    if (!token.lifespanMinutes) continue;

    if (token.lifespanMinutes < 5) distribution.under5m++;
    else if (token.lifespanMinutes < 30) distribution.from5mTo30m++;
    else if (token.lifespanMinutes < 120) distribution.from30mTo2h++;
    else if (token.lifespanMinutes < 1440) distribution.from2hTo24h++;
    else distribution.over24h++;
  }

  return distribution;
}

function generateSummary(result: ForensicsResult): string {
  const { totalCreatedTokens, totalMigratedTokens, migrationRate, avgLifespanMinutes, optimalVolumeRangeM } = result;

  const lifespanText = avgLifespanMinutes
    ? `Среднее время жизни токена — ${Math.round(avgLifespanMinutes)} минут.`
    : "Недостаточно данных для анализа времени жизни.";

  const migrationText = totalMigratedTokens > 0
    ? `${totalMigratedTokens} из ${totalCreatedTokens} токенов мигрировали (${migrationRate.toFixed(1)}%).`
    : "Ни один токен не мигрировал.";

  const volumeText = optimalVolumeRangeM
    ? `Лучшие результаты наблюдаются при запуске токенов, когда дневной объем Solana находится в диапазоне $${optimalVolumeRangeM.min}M - $${optimalVolumeRangeM.max}M.`
    : "";

  return `DEV создал ${totalCreatedTokens} токенов. ${migrationText} ${lifespanText} ${volumeText}`.trim();
}

function computeVolumeCorrelation(tokens: TokenForensics[]): VolumeCorrelationBin[] {
  const withVol = tokens.filter((t) => t.networkVolumeMAt_launch != null);
  if (withVol.length < 3) return [];

  const vols = withVol.map((t) => t.networkVolumeMAt_launch!);
  const minV = Math.min(...vols);
  const maxV = Math.max(...vols);
  const range = maxV - minV || 1;
  const BIN_COUNT = 5;
  const binSize = range / BIN_COUNT;

  const bins: VolumeCorrelationBin[] = Array.from({ length: BIN_COUNT }, (_, i) => ({
    label: `$${Math.round(minV + i * binSize)}M–$${Math.round(minV + (i + 1) * binSize)}M`,
    minM: minV + i * binSize,
    maxM: minV + (i + 1) * binSize,
    tokenCount: 0,
    migrationRate: 0,
    avgAthUsd: 0,
  }));

  for (const t of withVol) {
    const binIdx = Math.min(Math.floor((t.networkVolumeMAt_launch! - minV) / binSize), BIN_COUNT - 1);
    bins[binIdx].tokenCount++;
    if (t.isMigrated) bins[binIdx].migrationRate++;
    bins[binIdx].avgAthUsd += t.athUsd || 0;
  }

  for (const bin of bins) {
    if (bin.tokenCount > 0) {
      bin.migrationRate = bin.migrationRate / bin.tokenCount;
      bin.avgAthUsd = bin.avgAthUsd / bin.tokenCount;
    }
  }

  return bins.filter((b) => b.tokenCount > 0);
}

export async function GET(req: NextRequest) {
  const authHeaders = forwardedAuthHeaders(req);
  const creator = req.nextUrl.searchParams.get("creator")?.trim();
  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  const manualCreator = req.nextUrl.searchParams.get("manualCreator")?.trim();
  const includeTwitter = req.nextUrl.searchParams.get("includeTwitter") === "true";
  const fastMode = !!mint && !creator && !manualCreator;

  let targetCreator = creator || manualCreator || null;
  let singleTokenMint = mint || null;

  if (mint && !creator && !manualCreator) {
    targetCreator = await getCreatorForMint(mint, authHeaders);
    if (!targetCreator) {
      const { getDevTokenByMint } = await import("../../../../lib/trade/db");
      targetCreator = getDevTokenByMint(mint)?.creator || null;
    }
    if (!targetCreator) {
      singleTokenMint = mint;
      targetCreator = "unknown";
    }
  }

  if (!targetCreator && !singleTokenMint) {
    return NextResponse.json({ error: "creator or mint required" }, { status: 400 });
  }
  const resolvedCreator = targetCreator ?? "unknown";

  const cacheKey = fastMode && mint
    ? `${ATH_CACHE_VERSION}:${resolvedCreator}:${mint}:fast`
    : `${ATH_CACHE_VERSION}:${resolvedCreator}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  let tokens: DevTokenListItem[] = [];
  let reportedTotalTokens: number | null = null;
  let reportedMigratedTokens: number | null = null;

  if (singleTokenMint && targetCreator === "unknown") {
    tokens = [{ mint: singleTokenMint, symbol: "UNKNOWN" }];
  } else {
    try {
      const r = await fetch(`${req.nextUrl.origin}/api/trade/dev?creator=${encodeURIComponent(resolvedCreator)}`, {
        headers: authHeaders,
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const d = await r.json();
        const liveTokens = Array.isArray(d.tokens) ? d.tokens : [];
        const liveHasWallet = Number.isFinite(d.totalTokens) || Number.isFinite(d.migratedCount) || liveTokens.length > 0;

        if (liveHasWallet) {
          reportedTotalTokens = Number.isFinite(d.totalTokens) ? Number(d.totalTokens) : null;
          reportedMigratedTokens = Number.isFinite(d.migratedCount) ? Number(d.migratedCount) : null;
          tokens = liveTokens.map((token: any) => ({
            mint: token.mint,
            symbol: token.symbol || "UNKNOWN",
            name: token.name || null,
            createdAt: token.createdAt ?? null,
            marketCapUsd: token.marketCapUsd ?? null,
            athUsd: token.athUsd ?? null,
            isMigrated: token.isMigrated ?? null,
          }));
        }
      }
      if (!r.ok || tokens.length === 0) {
        const { getDevTokensByCreator } = await import("../../../../lib/trade/db");
        const dbTokens = getDevTokensByCreator(resolvedCreator, 5000);
        reportedTotalTokens = dbTokens.length;
        reportedMigratedTokens = dbTokens.filter((token) => token.isMigrated).length;
        tokens = dbTokens.map((token) => ({
          mint: token.mint,
          symbol: token.symbol || "UNKNOWN",
          name: token.name || null,
          createdAt: token.createdAt ? token.createdAt * 1000 : null,
          marketCapUsd: token.marketCapUsd ?? null,
          athUsd: token.athUsd ?? null,
          isMigrated: token.isMigrated,
        }));
      }
    } catch {
      const { getDevTokensByCreator } = await import("../../../../lib/trade/db");
      const dbTokens = getDevTokensByCreator(resolvedCreator, 5000);
      reportedTotalTokens = dbTokens.length;
      reportedMigratedTokens = dbTokens.filter((token) => token.isMigrated).length;
      tokens = dbTokens.map((token) => ({
        mint: token.mint,
        symbol: token.symbol || "UNKNOWN",
        name: token.name || null,
        createdAt: token.createdAt ? token.createdAt * 1000 : null,
        marketCapUsd: token.marketCapUsd ?? null,
        athUsd: token.athUsd ?? null,
        isMigrated: token.isMigrated,
      }));
    }

    if (singleTokenMint && targetCreator !== "unknown") {
      const hasToken = tokens.some((t) => t.mint === singleTokenMint);
      if (!hasToken) {
        const tokenInfo = await getPumpFunTokenInfo(singleTokenMint);
        tokens.push({
          mint: singleTokenMint,
          symbol: tokenInfo?.symbol || "UNKNOWN",
        });
      }
    }
  }

  const currentVolumeM = fastMode ? null : await fetchCurrentSolanaVolume();

  const enrichedTokenLimit = fastMode ? 12 : 50;
  const tokensToAnalyze = tokens.slice(0, enrichedTokenLimit);

  const enriched: TokenForensics[] = [];
  const BATCH = fastMode ? 4 : 2;

  for (let i = 0; i < tokensToAnalyze.length; i += BATCH) {
    const batch = tokensToAnalyze.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (t) => await analyzeToken(t.mint, {
        includeLaunchVolumes: !fastMode,
        includeTwitter,
        authHeaders,
      })),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        enriched.push(result.value);
      }
    }
  }

  const enrichedByMint = new Map(enriched.map((token) => [token.mint, token]));
  const metricsLiteByMint = new Map();
  const tokensMissingMetrics = tokens.filter((token) => {
    const enrichedToken = enrichedByMint.get(token.mint);
    return !enrichedToken || enrichedToken.tokenVolumeUsd === null;
  });

  if (tokensMissingMetrics.length > 0) {
    const METRICS_BATCH = 3;
    for (let i = 0; i < tokensMissingMetrics.length; i += METRICS_BATCH) {
      const batch = tokensMissingMetrics.slice(i, i + METRICS_BATCH);
      const results = await Promise.allSettled(
        batch.map(async (token) => {
          const metrics = await analyzeTokenMetricsLite(token.mint, resolvedCreator);
          return metrics ? [token.mint, metrics] : null;
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          metricsLiteByMint.set(result.value[0], result.value[1]);
        }
      }
    }
  }

  const fallbackTokens: TokenForensics[] = tokens.map((token) => {
    const enrichedToken = enrichedByMint.get(token.mint);
    if (enrichedToken) return enrichedToken;

    const lightweightMetrics = metricsLiteByMint.get(token.mint);
    return {
      mint: token.mint,
      symbol: token.symbol || "UNKNOWN",
      name: token.name || token.symbol || "UNKNOWN",
      createdAt: token.createdAt ?? null,
      lastActiveAt: null,
      lifespanHours: null,
      lifespanMinutes: null,
      networkVolumeMAt_launch: null,
      pumpFunVolumeMAt_launch: null,
      tokenVolumeSol: lightweightMetrics?.tokenVolumeSol ?? null,
      tokenVolumeUsd: lightweightMetrics?.tokenVolumeUsd ?? null,
      isMigrated: !!token.isMigrated,
      athUsd: token.athUsd ?? token.marketCapUsd ?? null,
      peakMarketCap: token.marketCapUsd ?? token.athUsd ?? null,
      historicalPeakMCAP: token.athUsd ?? token.marketCapUsd ?? null,
      creatorFeesUsd: null,
      totalFeesSol: null,
      totalFeesUsd: null,
      migrationMarketCap: null,
      migrationTimestamp: null,
    };
  });

  const statsTokens = fallbackTokens.length > 0 ? fallbackTokens : enriched;
  const displayTokens = fastMode ? statsTokens.slice(0, enrichedTokenLimit) : statsTokens;

  const totalCreatedTokens = reportedTotalTokens ?? statsTokens.length;
  const knownMigratedTokens = statsTokens.filter((t) => t.isMigrated).length;
  const totalMigratedTokens = reportedMigratedTokens ?? knownMigratedTokens;
  const migrationRate = totalCreatedTokens > 0 ? (totalMigratedTokens / totalCreatedTokens) * 100 : 0;

  const lifespansHours = enriched
    .map((t) => t.lifespanHours)
    .filter((h): h is number => h !== null);

  const lifespansMinutes = enriched
    .map((t) => t.lifespanMinutes)
    .filter((m): m is number => m !== null);

  const avgLifespanHours = lifespansHours.length > 0
    ? lifespansHours.reduce((a, b) => a + b, 0) / lifespansHours.length
    : null;

  const medianLifespanHours = lifespansHours.length > 0
    ? lifespansHours.sort((a, b) => a - b)[Math.floor(lifespansHours.length / 2)]
    : null;

  const avgLifespanMinutes = lifespansMinutes.length > 0
    ? lifespansMinutes.reduce((a, b) => a + b, 0) / lifespansMinutes.length
    : null;

  const medianLifespanMinutes = lifespansMinutes.length > 0
    ? lifespansMinutes.sort((a, b) => a - b)[Math.floor(lifespansMinutes.length / 2)]
    : null;

  const getMcapAth = (token: TokenForensics) => Math.max(
    token.historicalPeakMCAP || 0,
    token.peakMarketCap || 0,
    token.athUsd || 0,
  );

  const sortedByAth = statsTokens
    .filter((t) => getMcapAth(t) > 0)
    .sort((a, b) => getMcapAth(b) - getMcapAth(a));

  const bestToken = sortedByAth[0] || null;
  const worstToken = sortedByAth[sortedByAth.length - 1] || null;

  const successThreshold = 100000;
  const successCount = statsTokens.filter((t) => getMcapAth(t) >= successThreshold).length;
  const successRate = totalCreatedTokens > 0 ? (successCount / totalCreatedTokens) * 100 : 0;

  const lifetimeDistribution = calculateLifetimeDistribution(enriched);
  const volumeCorrelation = computeVolumeCorrelation(enriched);

  const optimalVolumeRangeM = volumeCorrelation.length > 0
    ? volumeCorrelation.reduce((best, current) =>
        current.migrationRate > best.migrationRate ? current : best
      ).tokenCount > 2
      ? {
          min: volumeCorrelation.reduce((best, current) =>
            current.migrationRate > best.migrationRate ? current : best
          ).minM,
          max: volumeCorrelation.reduce((best, current) =>
            current.migrationRate > best.migrationRate ? current : best
          ).maxM,
        }
      : null
    : null;

  const isOptimalLaunchTime = currentVolumeM && optimalVolumeRangeM
    ? currentVolumeM >= optimalVolumeRangeM.min && currentVolumeM <= optimalVolumeRangeM.max
    : false;

  const resolvedTokenVolumeTokens = statsTokens.filter(
    (token) => token.tokenVolumeUsd !== null && Number.isFinite(token.tokenVolumeUsd),
  );
  const resolvedCreatorFeeTokens = statsTokens.filter(
    (token) => token.creatorFeesUsd !== null && Number.isFinite(token.creatorFeesUsd),
  );
  const resolvedTokenVolumeUsdTotal = resolvedTokenVolumeTokens.reduce(
    (sum, token) => sum + (token.tokenVolumeUsd || 0),
    0,
  );
  const resolvedCreatorFeesUsdTotal = resolvedCreatorFeeTokens.reduce(
    (sum, token) => sum + (token.creatorFeesUsd || 0),
    0,
  );
  const averageTokenVolumeUsd = totalCreatedTokens > 0
    ? resolvedTokenVolumeUsdTotal / totalCreatedTokens
    : 0;
  const averageCreatorFeesUsd = totalCreatedTokens > 0
    ? resolvedCreatorFeesUsdTotal / totalCreatedTokens
    : 0;

  const summary = generateSummary({
    creator: resolvedCreator,
    totalCreatedTokens,
    totalMigratedTokens,
    migrationRate,
    avgLifespanHours,
    medianLifespanHours,
    avgLifespanMinutes,
    medianLifespanMinutes,
    averageTokenVolumeUsd,
    averageCreatorFeesUsd,
    resolvedTokenVolumeUsdTotal,
    resolvedCreatorFeesUsdTotal,
    resolvedTokenVolumeCount: resolvedTokenVolumeTokens.length,
    resolvedCreatorFeesCount: resolvedCreatorFeeTokens.length,
    tokens: displayTokens,
    volumeCorrelation,
    optimalVolumeRangeM,
    currentNetworkVolumeM: currentVolumeM,
    isOptimalLaunchTime,
    bestToken,
    worstToken,
    successRate,
    lifetimeDistribution,
    summary: "",
    lastUpdated: Date.now(),
  });

  const result: ForensicsResult = {
    creator: resolvedCreator,
    totalCreatedTokens,
    totalMigratedTokens,
    migrationRate,
    avgLifespanHours,
    medianLifespanHours,
    avgLifespanMinutes,
    medianLifespanMinutes,
    averageTokenVolumeUsd,
    averageCreatorFeesUsd,
    resolvedTokenVolumeUsdTotal,
    resolvedCreatorFeesUsdTotal,
    resolvedTokenVolumeCount: resolvedTokenVolumeTokens.length,
    resolvedCreatorFeesCount: resolvedCreatorFeeTokens.length,
    tokens: displayTokens,
    volumeCorrelation,
    optimalVolumeRangeM,
    currentNetworkVolumeM: currentVolumeM,
    isOptimalLaunchTime,
    bestToken,
    worstToken,
    successRate,
    lifetimeDistribution,
    summary,
    lastUpdated: Date.now(),
  };

  try {
    const { persistDevForensicsAnalysis, persistDevWallet, persistDevTokens } = await import("../../../../lib/trade/db");
    const now = Date.now();
    persistDevForensicsAnalysis({
      creator: resolvedCreator,
      sourceMint: mint || null,
      payload: result,
      totalCreatedTokens,
      totalMigratedTokens,
      migrationRate,
      avgLifespanMinutes,
      successRate,
      analyzedAt: now,
    });
    const mcapAthValues = enriched.map(getMcapAth).filter((value) => value > 0);
    persistDevWallet({
      address: resolvedCreator,
      totalTokens: totalCreatedTokens,
      migratedCount: totalMigratedTokens,
      migrationRate,
      reached300kCount: enriched.filter((token) => getMcapAth(token) >= 300000).length,
      rate300k: totalCreatedTokens > 0
        ? enriched.filter((token) => getMcapAth(token) >= 300000).length / totalCreatedTokens
        : 0,
      bestLaunchHour: null,
      totalVolumeSol: 0,
      totalFeesSol: 0,
      avgMcUsd: mcapAthValues.length > 0
        ? mcapAthValues.reduce((sum, value) => sum + value, 0) / mcapAthValues.length
        : null,
      maxMcUsd: mcapAthValues.length > 0 ? Math.max(...mcapAthValues) : null,
      source: "dev-forensics",
      lastUpdatedAt: now,
    });
    persistDevTokens(enriched.map((token) => ({
      mint: token.mint,
      creator: resolvedCreator,
      symbol: token.symbol || null,
      name: token.name || null,
      image: null,
      description: null,
      twitter: null,
      telegram: null,
      website: null,
      createdAt: token.createdAt ? Math.floor(token.createdAt / 1000) : null,
      marketCapUsd: getMcapAth(token),
      athUsd: token.athUsd,
      isMigrated: token.isMigrated,
      reached300k: getMcapAth(token) >= 300000,
      totalSupply: null,
      source: "dev-forensics",
      lastUpdatedAt: now,
    })));
  } catch (error) {
    console.warn("[dev-forensics] failed to persist analysis", error);
  }

  CACHE.set(cacheKey, { data: result, ts: Date.now() });
  return NextResponse.json(result);
}

async function getCreatorForMint(
  mint: string,
  authHeaders: Record<string, string> = {},
): Promise<string | null> {
  try {
    const { getDb } = await import("../../../../lib/trade/db");
    const row = getDb()
      .prepare("SELECT creator FROM dev_tokens WHERE mint = ? ORDER BY last_updated_at DESC LIMIT 1")
      .get(mint) as { creator?: string } | undefined;
    if (row?.creator && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.creator)) {
      return row.creator;
    }
  } catch {
    // ignore
  }

  try {
    const solscanInfo = await getSolscanTokenInfo(mint);
    if (solscanInfo?.creator && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solscanInfo.creator)) {
      return solscanInfo.creator;
    }
  } catch {
    // ignore
  }

  try {
    const creatorFromTx = await getSolscanCreatorFromTx(mint);
    if (creatorFromTx && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(creatorFromTx)) {
      return creatorFromTx;
    }
  } catch {
    // ignore
  }

  try {
    const { getCreatorForMint: resolveCreatorFromMint } = await import("../../../../lib/trade/dev");
    const resolved = await resolveCreatorFromMint(mint);
    if (resolved && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(resolved)) {
      return resolved;
    }
  } catch {
    // ignore
  }

  try {
    const baseUrl = process.env.NEXTAUTH_URL?.replace(/\/$/, "")
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    const r = await fetch(`${baseUrl}/api/trade/dev?mint=${encodeURIComponent(mint)}`, {
      headers: authHeaders,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.address)) {
        return d.address;
      }
    }
  } catch {
    // ignore
  }

  try {
    const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Origin": "https://pump.fun",
        "Referer": "https://pump.fun/"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (pumpRes.ok) {
      const pumpData = await pumpRes.json();
      if (pumpData.creator && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pumpData.creator)) {
        return pumpData.creator;
      }
    }
  } catch {
    // ignore
  }

  try {
    const tradeRes = await fetch(`https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=1`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (tradeRes.ok) {
      const tradeData = (await tradeRes.json()) as PumpTradeResponse;
      if (tradeData.trades?.[0]?.userAddress && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tradeData.trades[0].userAddress)) {
        console.log(`Found potential creator from first trade: ${tradeData.trades[0].userAddress} for token ${mint}`);
        return tradeData.trades[0].userAddress;
      }
    }
  } catch {
    // ignore
  }

  try {
    const transferData = await solscanApi<SolscanTransferResponse>(`/account/transfer?address=${mint}&limit=10`);
    const transfers = transferData?.data ?? [];
    if (transferData?.success && transfers.length > 0) {
      for (const transfer of transfers) {
        if (transfer.src && transfer.src !== mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(transfer.src)) {
          console.log(`Found potential creator from transfer: ${transfer.src} for token ${mint}`);
          return transfer.src;
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}
