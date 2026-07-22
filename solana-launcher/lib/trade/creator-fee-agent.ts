import { Connection, PublicKey } from "@solana/web3.js";
import { fetchPumpTrades } from "./pumpfun";

export interface TokenInput {
  mint: string;
  bondingCurveAddress?: string;
  isMigratedToRaydium: boolean;
  maxTrades?: number;
  skipSupplyRpc?: boolean;
}

export interface CreatorFeeReport {
  tokenMint: string;
  marketCapSol: number;
  marketCapUsd: number;
  feeBps: number;
  protocolFeeBps: number;
  lpFeeBps: number;
  totalFeeBps: number;
  feePercentage: number;
  feeTier: string;
  totalCreatorFeesSol: number;
  totalCreatorFeesUsd: number;
  totalProtocolFeesSol: number;
  totalProtocolFeesUsd: number;
  totalLpFeesSol: number;
  totalLpFeesUsd: number;
  totalFeesSol: number;
  totalFeesUsd: number;
  estimatedDailyFeesSol: number;
  estimatedDailyFeesUsd: number;
  estimatedDailyTotalFeesSol: number;
  estimatedDailyTotalFeesUsd: number;
  feeModel: "creator_fee" | "cashback";
  stage: "bonding_curve" | "completed_curve" | "migrated" | "failed";
  tradingVolume: {
    totalSol: number;
    totalUsd: number;
    dailySol: number;
    dailyUsd: number;
  };
  marketCap: {
    sol: number;
    usd: number;
  };
  feeInfo: {
    model: "creator_fee" | "cashback";
    bps: number;
    protocolBps: number;
    lpBps: number;
    totalBps: number;
    percentage: number;
    tier: string;
  };
  creatorFees: {
    total: { sol: number; usd: number };
    daily: { sol: number; usd: number };
  };
  protocolFees: {
    total: { sol: number; usd: number };
  };
  lpFees: {
    total: { sol: number; usd: number };
  };
  totalFees: {
    total: { sol: number; usd: number };
    daily: { sol: number; usd: number };
  };
  timestamp: string;
}

interface FeeTier {
  minMc: number;
  maxMc: number;
  bps: number;
  protocolBps: number;
  name: string;
  percentage: number;
}

interface DexPair {
  dexId?: string;
  priceUsd?: string;
  priceNative?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
}

const QUICKNODE_RPC = process.env.NEXT_PUBLIC_QUICKNODE_RPC_URL || process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const FEE_TIERS: Record<"bondingCurve" | "raydium", FeeTier[]> = {
  bondingCurve: [
    { minMc: 0, maxMc: 10, bps: 50, protocolBps: 100, name: "Tier 0: Micro Cap (<10 SOL)", percentage: 0.5 },
    { minMc: 10, maxMc: 100, bps: 40, protocolBps: 80, name: "Tier 1: Small Cap (10-100 SOL)", percentage: 0.4 },
    { minMc: 100, maxMc: 1000, bps: 30, protocolBps: 60, name: "Tier 2: Mid Cap (100-1000 SOL)", percentage: 0.3 },
    { minMc: 1000, maxMc: Infinity, bps: 20, protocolBps: 50, name: "Tier 3: Large Cap (>1000 SOL)", percentage: 0.2 },
  ],
  raydium: [
    { minMc: 0, maxMc: 10, bps: 50, protocolBps: 100, name: "Tier 0: Micro Cap (<10 SOL)", percentage: 0.5 },
    { minMc: 10, maxMc: 100, bps: 40, protocolBps: 80, name: "Tier 1: Small Cap (10-100 SOL)", percentage: 0.4 },
    { minMc: 100, maxMc: 1000, bps: 30, protocolBps: 60, name: "Tier 2: Mid Cap (100-1000 SOL)", percentage: 0.3 },
    { minMc: 1000, maxMc: Infinity, bps: 20, protocolBps: 50, name: "Tier 3: Large Cap (>1000 SOL)", percentage: 0.2 },
  ],
};

const cache = new Map<string, { ts: number; report: CreatorFeeReport }>();
const CACHE_TTL = 60_000;

export function calculateMarketCapOnCurve(virtualSolReserves: number, virtualTokenReserves: number, totalSupply: number): number {
  if (virtualSolReserves <= 0 || virtualTokenReserves <= 0 || totalSupply <= 0) return 0;
  return (virtualSolReserves / virtualTokenReserves) * totalSupply;
}

export function calculateMarketCapOnRaydium(solReserves: number, tokenReserves: number, totalSupply: number): number {
  if (solReserves <= 0 || tokenReserves <= 0 || totalSupply <= 0) return 0;
  return (solReserves / tokenReserves) * totalSupply;
}

export function getFeeTier(marketCapSol: number, isMigrated: boolean): FeeTier {
  const tiers = isMigrated ? FEE_TIERS.raydium : FEE_TIERS.bondingCurve;
  return tiers.find((tier) => marketCapSol >= tier.minMc && marketCapSol < tier.maxMc) || tiers[tiers.length - 1];
}

function getTokenStage(marketCapUsd: number, isMigrated: boolean): CreatorFeeReport["stage"] {
  if (isMigrated) return "migrated";
  if (marketCapUsd >= 80000) return "completed_curve";
  if (marketCapUsd > 0) return "bonding_curve";
  return "failed";
}

async function getSolPriceUsd(): Promise<number> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return 150;
    const json = await r.json() as { pairs?: DexPair[] };
    const pair = json.pairs?.find((p) => Number(p.priceUsd) > 0) || json.pairs?.[0];
    return Number(pair?.priceUsd) || 150;
  } catch {
    return 150;
  }
}

function deriveSolPriceUsd(pair: DexPair | null, fallback: number): number {
  const priceUsd = Number(pair?.priceUsd) || 0;
  const priceNative = Number(pair?.priceNative) || 0;
  if (priceUsd > 0 && priceNative > 0) return priceUsd / priceNative;
  return fallback;
}

async function fetchDexPair(mint: string): Promise<DexPair | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const json = await r.json() as { pairs?: DexPair[] };
    const pairs = json.pairs || [];
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  } catch {
    return null;
  }
}

async function getTotalSupply(mint: string): Promise<number | null> {
  try {
    const connection = new Connection(QUICKNODE_RPC, "confirmed");
    const supply = await connection.getTokenSupply(new PublicKey(mint));
    return supply.value.uiAmount;
  } catch {
    return null;
  }
}

async function fetchPumpMetadata(mint: string): Promise<{ marketCapUsd?: number; virtualSolReserves?: number; virtualTokenReserves?: number; totalSupply?: number; complete?: boolean; raydiumPool?: string | null; cashback?: boolean } | null> {
  const endpoints = [
    `https://swap-api.pump.fun/v2/coins/${mint}`,
    `https://frontend-api.pump.fun/coins/${mint}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) continue;
      const d = await r.json() as any;
      return {
        marketCapUsd: Number(d.usd_market_cap || d.market_cap_usd || d.marketCapUsd || d.market_cap) || undefined,
        virtualSolReserves: Number(d.virtual_sol_reserves) > 0 ? Number(d.virtual_sol_reserves) / 1e9 : undefined,
        virtualTokenReserves: Number(d.virtual_token_reserves) > 0 ? Number(d.virtual_token_reserves) / 1e6 : undefined,
        totalSupply: Number(d.total_supply || d.totalSupply) > 0 ? Number(d.total_supply || d.totalSupply) / 1e6 : undefined,
        complete: Boolean(d.complete),
        raydiumPool: d.raydium_pool || d.raydiumPool || null,
        cashback: Boolean(d.cashback),
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function getFeeModel(mint: string, metadata: Awaited<ReturnType<typeof fetchPumpMetadata>>): Promise<"creator_fee" | "cashback"> {
  if (metadata?.cashback) return "cashback";
  return "creator_fee";
}

async function calculateTradeMetrics(
  mint: string,
  maxTrades: number,
  totalSupply: number,
  isMigrated: boolean,
  feeModel: "creator_fee" | "cashback",
): Promise<{
  totalSol: number;
  dailySol: number;
  totalCreatorFeesSol: number;
  totalProtocolFeesSol: number;
  totalLpFeesSol: number;
  totalFeesSol: number;
  dailyCreatorFeesSol: number;
  dailyTotalFeesSol: number;
}> {
  try {
    const trades = await fetchPumpTrades(mint, maxTrades);
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    return trades.reduce(
      (acc, trade) => {
        const tradeSol = trade.amountSol || 0;
        const tradeMarketCapSol = trade.priceSol > 0 && totalSupply > 0
          ? trade.priceSol * totalSupply
          : 0;
        const tradeTier = getFeeTier(tradeMarketCapSol, isMigrated);
        const creatorBps = feeModel === "cashback" ? 0 : tradeTier.bps;
        const protocolBps = tradeTier.protocolBps;
        const lpBps = isMigrated ? 20 : 0;
        const totalBps = creatorBps + protocolBps + lpBps;
        const creatorFeeSol = tradeSol * (creatorBps / 10000);
        const protocolFeeSol = tradeSol * (protocolBps / 10000);
        const lpFeeSol = tradeSol * (lpBps / 10000);
        const totalFeeSol = tradeSol * (totalBps / 10000);

        acc.totalSol += tradeSol;
        acc.totalCreatorFeesSol += creatorFeeSol;
        acc.totalProtocolFeesSol += protocolFeeSol;
        acc.totalLpFeesSol += lpFeeSol;
        acc.totalFeesSol += totalFeeSol;

        if (trade.timestamp >= dayAgo) {
          acc.dailySol += tradeSol;
          acc.dailyCreatorFeesSol += creatorFeeSol;
          acc.dailyTotalFeesSol += totalFeeSol;
        }
        return acc;
      },
      {
        totalSol: 0,
        dailySol: 0,
        totalCreatorFeesSol: 0,
        totalProtocolFeesSol: 0,
        totalLpFeesSol: 0,
        totalFeesSol: 0,
        dailyCreatorFeesSol: 0,
        dailyTotalFeesSol: 0,
      },
    );
  } catch {
    return {
      totalSol: 0,
      dailySol: 0,
      totalCreatorFeesSol: 0,
      totalProtocolFeesSol: 0,
      totalLpFeesSol: 0,
      totalFeesSol: 0,
      dailyCreatorFeesSol: 0,
      dailyTotalFeesSol: 0,
    };
  }
}

export async function analyzePumpFunCreatorFee(input: TokenInput): Promise<CreatorFeeReport> {
  const maxTrades = input.maxTrades ?? 1000;
  const cached = cache.get(`${input.mint}:${input.isMigratedToRaydium}:${maxTrades}`);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.report;

  const [metadata, dexPair, totalSupplyFromRpc] = await Promise.all([
    fetchPumpMetadata(input.mint),
    fetchDexPair(input.mint),
    input.skipSupplyRpc ? Promise.resolve(null) : getTotalSupply(input.mint),
  ]);

  const pairSolPriceUsd = deriveSolPriceUsd(dexPair, 0);
  const solPriceUsd = pairSolPriceUsd || await getSolPriceUsd();
  const isMigrated = input.isMigratedToRaydium || Boolean(metadata?.complete || metadata?.raydiumPool || (dexPair?.dexId && dexPair.dexId !== "pumpfun"));
  const totalSupply = metadata?.totalSupply || totalSupplyFromRpc || 1_000_000_000;
  let marketCapUsd = Number(dexPair?.marketCap || dexPair?.fdv || metadata?.marketCapUsd) || 0;
  let marketCapSol = marketCapUsd > 0 ? marketCapUsd / solPriceUsd : 0;

  if (!marketCapSol && metadata?.virtualSolReserves && metadata?.virtualTokenReserves) {
    marketCapSol = calculateMarketCapOnCurve(metadata.virtualSolReserves, metadata.virtualTokenReserves, totalSupply);
    marketCapUsd = marketCapSol * solPriceUsd;
  }

  const feeTier = getFeeTier(marketCapSol, isMigrated);
  const lpFeeBps = isMigrated ? 20 : 0;
  const totalFeeBps = feeTier.bps + feeTier.protocolBps + lpFeeBps;
  const feeModel = await getFeeModel(input.mint, metadata);
  const metrics = await calculateTradeMetrics(input.mint, maxTrades, totalSupply, isMigrated, feeModel);
  const totalCreatorFeesSol = metrics.totalCreatorFeesSol;
  const totalProtocolFeesSol = metrics.totalProtocolFeesSol;
  const totalLpFeesSol = metrics.totalLpFeesSol;
  const totalFeesSol = metrics.totalFeesSol;
  const estimatedDailyFeesSol = metrics.dailyCreatorFeesSol;
  const estimatedDailyTotalFeesSol = metrics.dailyTotalFeesSol;

  const report: CreatorFeeReport = {
    tokenMint: input.mint,
    marketCapSol,
    marketCapUsd,
    feeBps: feeTier.bps,
    protocolFeeBps: feeTier.protocolBps,
    lpFeeBps,
    totalFeeBps,
    feePercentage: feeTier.percentage,
    feeTier: feeTier.name,
    totalCreatorFeesSol,
    totalCreatorFeesUsd: totalCreatorFeesSol * solPriceUsd,
    totalProtocolFeesSol,
    totalProtocolFeesUsd: totalProtocolFeesSol * solPriceUsd,
    totalLpFeesSol,
    totalLpFeesUsd: totalLpFeesSol * solPriceUsd,
    totalFeesSol,
    totalFeesUsd: totalFeesSol * solPriceUsd,
    estimatedDailyFeesSol,
    estimatedDailyFeesUsd: estimatedDailyFeesSol * solPriceUsd,
    estimatedDailyTotalFeesSol,
    estimatedDailyTotalFeesUsd: estimatedDailyTotalFeesSol * solPriceUsd,
    feeModel,
    stage: getTokenStage(marketCapUsd, isMigrated),
    tradingVolume: {
      totalSol: metrics.totalSol,
      totalUsd: metrics.totalSol * solPriceUsd,
      dailySol: metrics.dailySol,
      dailyUsd: metrics.dailySol * solPriceUsd,
    },
    marketCap: {
      sol: marketCapSol,
      usd: marketCapUsd,
    },
    feeInfo: {
      model: feeModel,
      bps: feeTier.bps,
      protocolBps: feeTier.protocolBps,
      lpBps: lpFeeBps,
      totalBps: totalFeeBps,
      percentage: feeTier.percentage,
      tier: feeTier.name,
    },
    creatorFees: {
      total: { sol: totalCreatorFeesSol, usd: totalCreatorFeesSol * solPriceUsd },
      daily: { sol: estimatedDailyFeesSol, usd: estimatedDailyFeesSol * solPriceUsd },
    },
    protocolFees: {
      total: { sol: totalProtocolFeesSol, usd: totalProtocolFeesSol * solPriceUsd },
    },
    lpFees: {
      total: { sol: totalLpFeesSol, usd: totalLpFeesSol * solPriceUsd },
    },
    totalFees: {
      total: { sol: totalFeesSol, usd: totalFeesSol * solPriceUsd },
      daily: { sol: estimatedDailyTotalFeesSol, usd: estimatedDailyTotalFeesSol * solPriceUsd },
    },
    timestamp: new Date().toISOString(),
  };

  cache.set(`${input.mint}:${input.isMigratedToRaydium}:${maxTrades}`, { ts: Date.now(), report });
  return report;
}
