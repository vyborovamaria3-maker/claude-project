// Mock data layer. Each export carries a "data-tag" describing the future API source.
// Replace the static values with real API responses by swapping the functions in lib/api.ts.

export type Trend = {
  id: string;
  ticker: string;
  name: string;
  price: string;
  changePct: number;
  icon?: string;
};

// data-tag: trending.list  (GET /api/trending)
export const trending: Trend[] = [
  { id: "ASTR", ticker: "$ASTR", name: "Asteroid", price: "$90.4K", changePct: 12.3, icon: "SA" },
  { id: "JDPT", ticker: "JDPT", name: "JDpT...sntJ", price: "40.0 SOL", changePct: 4.2, icon: "JD" },
  { id: "2DPU", ticker: "2DPU", name: "2DPU...atqN", price: "36.5 SOL", changePct: -1.7, icon: "2D" },
  { id: "5CJC", ticker: "5CJC", name: "5cjc...XUW6", price: "25.5 SOL", changePct: 8.9, icon: "5C" },
  { id: "ASTR2", ticker: "$ASTR", name: "Asteroid", price: "$90.4K", changePct: 6.1, icon: "SA" },
];

// data-tag: wallet.master  (GET /api/wallet/master)
export const masterWallet = {
  label: "Master Wallet",
  balanceSol: 18.4321,
};

// data-tag: user.session  (GET /api/me)
export const currentUser = {
  username: "user_potapoff",
};

type PersonalLaunch = {
  id: string;
  symbol: string;
  name: string;
  createdAt: number;
  budgetSol: number;
  feeSol: number;
  athUsd: number;
  currentMcapUsd: number;
  migrated: boolean;
  status: "active" | "dead" | "migrated";
  wallets: string[];
};

type PersonalTrade = {
  id: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  createdAt: number;
  volumeSol: number;
  feeSol: number;
  pnlSol: number;
  holdMinutes: number;
  wallet: string;
  source: "manual" | "bot";
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SOL_USD = 172;
const now = Date.now();
const ago = (hours: number) => now - hours * HOUR_MS;

// ТОЛЬКО МОИ ЗАПУСКИ - изначально пусто, все метрики = 0
// Здесь будут добавляться мои реальные токены при создании
const myLaunches: PersonalLaunch[] = [
  // Примеры данных (закомментированы - начальное состояние = 0):
  // { id: "launch_1", symbol: "TOKEN1", name: "Token One", createdAt: ago(2), budgetSol: 5.2, feeSol: 2.0, athUsd: 47000, currentMcapUsd: 42000, migrated: false, status: "active", wallets: ["dev", "bundle-1"] },
];

// ТОЛЬКО МОИ ТРЕЙДЫ - изначально пусто, все метрики = 0
// Здесь будут добавляться мои реальные сделки при торговле
const myTrades: PersonalTrade[] = [
  // Примеры данных (закомментированы - начальное состояние = 0):
  // { id: "trade_1", mint: "photon", symbol: "PHOTON", side: "buy", createdAt: ago(0.2), volumeSol: 0.9, feeSol: 0.008, pnlSol: 0.14, holdMinutes: 18, wallet: "bot-1", source: "bot" },
];

function periodToMs(period: string): number {
  switch (period) {
    case "1H": return HOUR_MS;
    case "1D": return DAY_MS;
    case "7D": return 7 * DAY_MS;
    case "30D": return 30 * DAY_MS;
    case "90D": return 90 * DAY_MS;
    case "1Y": return 365 * DAY_MS;
    default: return Number.POSITIVE_INFINITY;
  }
}

function isInPeriod(timestamp: number, period: string) {
  const range = periodToMs(period);
  if (!Number.isFinite(range)) return true;
  return timestamp >= now - range;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en", { day: "2-digit", month: "short" });
}

export type PeriodStats = {
  tradingVolume: { sol: number; usd: number };
  feesPaid: { sol: number; usd: number };
  pnl: { sol: number; usd: number };
  ath: { token: string; mcap: number; date: string };
  tokensCreated: number;
  walletsUsed: number;
  trades: number;
  averageAthUsd: number;
  migrations: number;
  migrationRate: number;
  winRate: number;
  avgTradeSizeSol: number;
  avgHoldMinutes: number;
  launchFeesSol: number;
  tradeFeesSol: number;
  avgLaunchBudgetSol: number;
  successfulLaunches: number;
  bestTradePnlSol: number;
  activeTokens: number;
};

const ZERO_STATS: PeriodStats = {
  tradingVolume: { sol: 0, usd: 0 },
  feesPaid: { sol: 0, usd: 0 },
  pnl: { sol: 0, usd: 0 },
  ath: { token: "—", mcap: 0, date: "—" },
  tokensCreated: 0,
  walletsUsed: 0,
  trades: 0,
  averageAthUsd: 0,
  migrations: 0,
  migrationRate: 0,
  winRate: 0,
  avgTradeSizeSol: 0,
  avgHoldMinutes: 0,
  launchFeesSol: 0,
  tradeFeesSol: 0,
  avgLaunchBudgetSol: 0,
  successfulLaunches: 0,
  bestTradePnlSol: 0,
  activeTokens: 0,
};

export function getPeriodStats(period: string): PeriodStats {
  const launches = myLaunches.filter((launch) => isInPeriod(launch.createdAt, period));
  const trades = myTrades.filter((trade) => isInPeriod(trade.createdAt, period));
  if (launches.length === 0 && trades.length === 0) return ZERO_STATS;

  const launchVolume = launches.reduce((sum, launch) => sum + launch.budgetSol, 0);
  const tradeVolume = trades.reduce((sum, trade) => sum + trade.volumeSol, 0);
  const launchFeesSol = launches.reduce((sum, launch) => sum + launch.feeSol, 0);
  const tradeFeesSol = trades.reduce((sum, trade) => sum + trade.feeSol, 0);
  const totalPnlSol = trades.reduce((sum, trade) => sum + trade.pnlSol, 0);
  const bestAthLaunch = launches.slice().sort((a, b) => b.athUsd - a.athUsd)[0];
  const migrations = launches.filter((launch) => launch.migrated).length;
  const positiveTrades = trades.filter((trade) => trade.pnlSol > 0).length;
  const walletsUsed = new Set([...launches.flatMap((launch) => launch.wallets), ...trades.map((trade) => trade.wallet)]).size;

  return {
    tradingVolume: { sol: launchVolume + tradeVolume, usd: (launchVolume + tradeVolume) * SOL_USD },
    feesPaid: { sol: launchFeesSol + tradeFeesSol, usd: (launchFeesSol + tradeFeesSol) * SOL_USD },
    pnl: { sol: totalPnlSol, usd: totalPnlSol * SOL_USD },
    ath: bestAthLaunch
      ? { token: bestAthLaunch.symbol, mcap: bestAthLaunch.athUsd, date: formatDate(bestAthLaunch.createdAt) }
      : { token: "—", mcap: 0, date: "—" },
    tokensCreated: launches.length,
    walletsUsed,
    trades: trades.length,
    averageAthUsd: average(launches.map((launch) => launch.athUsd)),
    migrations,
    migrationRate: launches.length ? migrations / launches.length : 0,
    winRate: trades.length ? positiveTrades / trades.length : 0,
    avgTradeSizeSol: average(trades.map((trade) => trade.volumeSol)),
    avgHoldMinutes: average(trades.map((trade) => trade.holdMinutes)),
    launchFeesSol,
    tradeFeesSol,
    avgLaunchBudgetSol: average(launches.map((launch) => launch.budgetSol)),
    successfulLaunches: launches.filter((launch) => launch.athUsd >= 100000).length,
    bestTradePnlSol: trades.length ? Math.max(...trades.map((trade) => trade.pnlSol)) : 0,
    activeTokens: launches.filter((launch) => launch.status === "active").length,
  };
}

const ALL_STATS = getPeriodStats("ALL");
const THIRTY_DAY_STATS = getPeriodStats("30D");
const ONE_DAY_STATS = getPeriodStats("1D");

// data-tag: dashboard.stats  (GET /api/dashboard/stats)
export const dashboardStats = {
  bundlesLaunched: { value: ALL_STATS.tokensCreated, active: THIRTY_DAY_STATS.tokensCreated },
  totalInvested: { display: `${ALL_STATS.tradingVolume.sol.toFixed(1)} SOL`, wallets: ALL_STATS.walletsUsed, trades: ALL_STATS.trades },
  feesPaid: { sol: ALL_STATS.feesPaid.sol, usd: ALL_STATS.feesPaid.usd },
  bumpBotPnl: { sol: ALL_STATS.pnl.sol, usd: ALL_STATS.pnl.usd, executedTrades: ALL_STATS.trades },
};

// data-tag: pnl.realized_overview  (GET /api/pnl/realized?range=30d)
export const realizedPnl = {
  today: ONE_DAY_STATS.pnl.sol,
  threeDay: getPeriodStats("7D").pnl.sol,
  winRate: THIRTY_DAY_STATS.winRate,
  trades: THIRTY_DAY_STATS.trades,
  totalSol: THIRTY_DAY_STATS.pnl.sol,
};

function getBucketConfig(period: string) {
  switch (period) {
    case "1H":
      return { bucketMs: 5 * 60 * 1000, count: 12, formatLabel: (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) };
    case "1D":
      return { bucketMs: HOUR_MS, count: 24, formatLabel: (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) };
    case "7D":
      return { bucketMs: DAY_MS, count: 7, formatLabel: (ts: number) => formatDate(ts) };
    case "30D":
      return { bucketMs: 2 * DAY_MS, count: 15, formatLabel: (ts: number) => formatDate(ts) };
    case "90D":
      return { bucketMs: 7 * DAY_MS, count: 13, formatLabel: (ts: number) => formatDate(ts) };
    case "1Y":
      return { bucketMs: 30 * DAY_MS, count: 12, formatLabel: (ts: number) => new Date(ts).toLocaleString("en", { month: "short" }) };
    default:
      return { bucketMs: 30 * DAY_MS, count: 6, formatLabel: (ts: number) => new Date(ts).toLocaleString("en", { month: "short" }) };
  }
}

// data-tag: dashboard.chart_data  (GET /api/dashboard/chart?metric=...)
export function getChartData(metric: "pnl" | "volume" | "ath", period: string = "30D"): { date: string; value: number }[] {
  const { bucketMs, count, formatLabel } = getBucketConfig(period);
  const start = now - bucketMs * count;

  const trades = myTrades.filter((trade) => trade.createdAt >= start && isInPeriod(trade.createdAt, period));
  const launches = myLaunches.filter((launch) => launch.createdAt >= start && isInPeriod(launch.createdAt, period));

  // Для ATH графика - показываем каждый токен отдельно (1 токен = 1 точка на оси X)
  if (metric === "ath" && launches.length > 0) {
    return launches
      .slice()
      .sort((a, b) => b.athUsd - a.athUsd) // Сортируем по ATH (убывание)
      .map((launch) => ({
        date: launch.symbol, // Символ токена на оси X
        value: launch.athUsd,
      }));
  }

  // Для остальных метрик - time-based buckets
  const buckets = Array.from({ length: count }, (_, index) => ({ start: start + index * bucketMs, value: 0 }));

  for (const trade of trades) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((trade.createdAt - start) / bucketMs)));
    if (metric === "pnl") buckets[index].value += trade.pnlSol;
    if (metric === "volume") buckets[index].value += trade.volumeSol;
  }

  for (const launch of launches) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((launch.createdAt - start) / bucketMs)));
    if (metric === "volume") buckets[index].value += launch.budgetSol;
  }

  return buckets.map((bucket) => ({
    date: formatLabel(bucket.start),
    value: Number(bucket.value.toFixed(metric === "ath" ? 0 : 3)),
  }));
}

// data-tag: pnl.chart_30d  (GET /api/pnl/chart?range=30d)
export const pnlChartData = getChartData("pnl", "30D");
