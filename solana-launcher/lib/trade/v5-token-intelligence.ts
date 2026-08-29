import type { ChainAnalysis, Market } from "./social-intelligence";

export type V5TokenIntelligence = {
  schemaVersion: "token-intelligence-v3";
  coverage: { completeHistory: boolean; completeOneHour: boolean; tradeCount: number; rawTradeCount: number };
  orderFlow: {
    p95TradeSol: number | null;
    whaleBuyVolumeSol1h: number | null;
    whaleSellVolumeSol1h: number | null;
    imbalance1h: number | null;
    burstiness1h: number | null;
    repeatedSizeRatio1h: number | null;
    buyPressurePersistence15m: number | null;
  };
  demandQuality: {
    uniqueBuyers5m: number | null;
    uniqueBuyers1h: number | null;
    newBuyerShare1h: number | null;
    repeatBuyerShare1h: number | null;
    buyerConcentrationHhi1h: number | null;
    independentBuyVolumeRatio1h: number | null;
  };
  lifecycle: { regime: "accumulation" | "expansion" | "distribution" | "decay" | "mixed" | null; confidence: number | null; survivalScore: number | null };
  scores: { sellPressure: number | null; launchHealth: number | null; independentDemand: number | null; confidence: number };
  market: { liquidityUsd: number | null; volume24hUsd: number | null; volumeToLiquidity: number | null };
  guardrails: string[];
};

type Trade = { ts: number; side: "buy" | "sell"; wallet: string; amountSol: number; price: number | null };

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestampMs = (value: number) => (value < 10_000_000_000 ? value * 1000 : value);

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
}

function toTrades(chain: ChainAnalysis | null, mint: string, asOf: number): Trade[] {
  return (chain?.trades ?? []).flatMap((row) => {
    const ts = finite(row.ts) ? timestampMs(row.ts) : 0;
    const amountSol = finite(row.s) && row.s >= 0 ? row.s : null;
    const side = row.t === 1 ? "buy" : row.t === 0 ? "sell" : null;
    if (!ts || ts > asOf || !side || amountSol == null || !row.w) return [];
    return [{ ts, side, wallet: row.w, amountSol, price: finite(row.p) && row.p > 0 ? row.p : null }];
  });
}

export function deriveV5TokenIntelligence(args: { mint: string; chain: ChainAnalysis | null; market: Market | null; asOf?: number }): V5TokenIntelligence {
  const asOf = args.asOf ?? Date.now();
  const trades = toTrades(args.chain, args.mint, asOf);
  const rawTradeCount = Number(args.chain?.summary?.totalRawTrades ?? args.chain?.summary?.totalTrades ?? trades.length);
  const truncated = Boolean(args.chain?.summary?.historyTruncated ?? args.chain?.truncated);
  const completeHistory = Boolean(trades.length && !truncated && rawTradeCount <= trades.length);
  const oneHour = trades.filter((trade) => trade.ts >= asOf - 60 * 60_000);
  const fifteenMinutes = oneHour.filter((trade) => trade.ts >= asOf - 15 * 60_000);
  const fiveMinutes = oneHour.filter((trade) => trade.ts >= asOf - 5 * 60_000);
  const completeOneHour = completeHistory && oneHour.length > 0;
  const amounts = oneHour.map((trade) => trade.amountSol);
  const p95 = completeOneHour ? percentile(amounts, 0.95) : null;
  const whaleBuys = p95 == null ? [] : oneHour.filter((trade) => trade.side === "buy" && trade.amountSol >= p95);
  const whaleSells = p95 == null ? [] : oneHour.filter((trade) => trade.side === "sell" && trade.amountSol >= p95);
  const buyVolume = (rows: Trade[]) => rows.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + trade.amountSol, 0);
  const sellVolume = (rows: Trade[]) => rows.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + trade.amountSol, 0);
  const totalBuy = buyVolume(oneHour);
  const totalSell = sellVolume(oneHour);
  const totalVolume = totalBuy + totalSell;
  const wallets = new Map<string, number>();
  for (const trade of oneHour.filter((row) => row.side === "buy")) wallets.set(trade.wallet, (wallets.get(trade.wallet) ?? 0) + trade.amountSol);
  const buyerTotal = [...wallets.values()].reduce((sum, value) => sum + value, 0);
  const hhi = buyerTotal ? [...wallets.values()].reduce((sum, value) => sum + (value / buyerTotal) ** 2, 0) : null;
  const firstSeen = new Map<string, number>();
  for (const trade of trades) firstSeen.set(trade.wallet, Math.min(firstSeen.get(trade.wallet) ?? Infinity, trade.ts));
  const newBuyers = completeHistory ? oneHour.filter((trade) => trade.side === "buy" && (firstSeen.get(trade.wallet) ?? trade.ts) >= asOf - 60 * 60_000).map((trade) => trade.wallet) : [];
  const uniqueBuyers1h = completeHistory ? new Set(oneHour.filter((trade) => trade.side === "buy").map((trade) => trade.wallet)).size : null;
  const repeatBuyers = completeHistory ? [...wallets.keys()].filter((wallet) => oneHour.filter((trade) => trade.side === "buy" && trade.wallet === wallet).length > 1).length : null;
  const burstBuckets = new Map<number, number>();
  for (const trade of oneHour) { const bucket = Math.floor(trade.ts / 1000); burstBuckets.set(bucket, (burstBuckets.get(bucket) ?? 0) + 1); }
  const maxBurst = burstBuckets.size ? Math.max(...burstBuckets.values()) : 0;
  const repeatedSizes = oneHour.length ? oneHour.filter((trade, index) => oneHour.some((other, otherIndex) => otherIndex !== index && Math.abs(other.amountSol - trade.amountSol) <= Math.max(0.000001, trade.amountSol * 0.01))).length / oneHour.length : null;
  const pressure = totalVolume ? totalSell / totalVolume * 100 : null;
  const buyPersistence = fifteenMinutes.length ? buyVolume(fifteenMinutes) / Math.max(0.000001, buyVolume(oneHour)) * 100 : null;
  const volumeToLiquidity = finite(args.market?.pair?.liquidityUsd) && finite(args.market?.pair?.volumeH24) && args.market.pair.liquidityUsd > 0 ? args.market.pair.volumeH24 / args.market.pair.liquidityUsd : null;
  const sellPressure = pressure == null ? null : clamp(pressure * 0.7 + (whaleSells.length > whaleBuys.length ? 20 : 0));
  const independent = hhi == null ? null : clamp((1 - hhi) * 100);
  const launchHealth = totalVolume ? clamp((1 - (sellPressure ?? 50) / 100) * 55 + (independent ?? 50) * 0.3 + clamp((fiveMinutes.length / Math.max(1, fifteenMinutes.length)) * 100) * 0.15) : null;
  const regime = !oneHour.length ? null : (sellPressure != null && sellPressure >= 65 ? "distribution" : (buyPersistence != null && buyPersistence >= 55 && totalBuy > totalSell ? "expansion" : oneHour.length < 5 ? "accumulation" : "mixed"));
  return {
    schemaVersion: "token-intelligence-v3",
    coverage: { completeHistory, completeOneHour, tradeCount: trades.length, rawTradeCount },
    orderFlow: { p95TradeSol: p95, whaleBuyVolumeSol1h: completeOneHour ? buyVolume(whaleBuys) : null, whaleSellVolumeSol1h: completeOneHour ? sellVolume(whaleSells) : null, imbalance1h: completeOneHour && totalVolume ? (totalBuy - totalSell) / totalVolume * 100 : null, burstiness1h: completeOneHour ? clamp(maxBurst / Math.max(1, oneHour.length) * 100) : null, repeatedSizeRatio1h: completeOneHour ? repeatedSizes : null, buyPressurePersistence15m: completeOneHour ? buyPersistence : null },
    demandQuality: { uniqueBuyers5m: completeHistory ? new Set(fiveMinutes.filter((row) => row.side === "buy").map((row) => row.wallet)).size : null, uniqueBuyers1h, newBuyerShare1h: completeHistory && uniqueBuyers1h ? new Set(newBuyers).size / uniqueBuyers1h * 100 : null, repeatBuyerShare1h: repeatBuyers != null && uniqueBuyers1h ? repeatBuyers / uniqueBuyers1h * 100 : null, buyerConcentrationHhi1h: completeOneHour ? hhi : null, independentBuyVolumeRatio1h: independent },
    lifecycle: { regime, confidence: regime ? clamp((completeHistory ? 70 : 35) + Math.min(25, oneHour.length)) : null, survivalScore: completeHistory ? clamp(100 - (sellPressure ?? 50)) : null },
    scores: { sellPressure, launchHealth, independentDemand: independent, confidence: clamp((completeHistory ? 70 : 35) + Math.min(30, trades.length)) },
    market: { liquidityUsd: args.market?.pair?.liquidityUsd ?? null, volume24hUsd: args.market?.pair?.volumeH24 ?? null, volumeToLiquidity },
    guardrails: ["V5 metrics are additive and do not overwrite social scores.", "Position cohorts and historical analogs remain unavailable without complete indexed inputs.", "Bundle or trade-time proximity is not funding, ownership, identity or payment evidence.", "Incomplete history returns null for completeness-sensitive one-hour metrics."],
  };
}
