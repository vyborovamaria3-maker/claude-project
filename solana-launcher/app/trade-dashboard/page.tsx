"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  BarChart3,
  Activity,
  TrendingUp,
  Zap,
  Target,
  Clock,
  Sparkles,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  Gauge,
  PieChart,
  LineChart as LineChartIcon,
} from "lucide-react";
import PeriodSelector, { type Period } from "@/components/PeriodSelector";
import { getPeriodStats, getChartData } from "@/lib/mockData";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, PieChart as RePieChart, Pie, Cell, AreaChart, Area } from "recharts";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

// РўРѕР»СЊРєРѕ РјРѕРё trade РјРµС‚СЂРёРєРё
const TRADE_PERIODS = ["1H", "1D", "7D", "30D", "90D", "1Y", "ALL"] as const;

type TradeMetric = {
  label: string;
  value: string;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  icon: typeof Activity;
};

export default function TradeDashboardPage() {
  const [period, setPeriod] = useState<Period>("30D");
  const isMobile = useIsMobileViewport();
  const stats = useMemo(() => getPeriodStats(period), [period]);

  // РўРѕР»СЊРєРѕ РјРѕРё trades - РЅРµ С‡СѓР¶РёРµ!
  const myTrades = stats.trades;
  const myPnl = stats.pnl.sol;
  const myPnlUsd = stats.pnl.usd;
  const myWinRate = stats.winRate * 100;
  const myVolume = stats.tradingVolume.sol;
  const myTradeFees = stats.tradeFeesSol;
  const myAvgHold = stats.avgHoldMinutes;
  const myAvgTradeSize = stats.avgTradeSizeSol;
  const myBestTrade = stats.bestTradePnlSol;
  const myWalletsUsed = stats.walletsUsed;

  const isProfitable = myPnl > 0;

  const metrics: TradeMetric[] = [
    {
      label: "My Trades",
      value: String(myTrades),
      change: period,
      icon: Activity,
    },
    {
      label: "Total PnL",
      value: `${isProfitable ? "+" : ""}${myPnl.toFixed(3)} SOL`,
      change: `$${myPnlUsd.toFixed(0)}`,
      changeType: isProfitable ? "positive" : myPnl < 0 ? "negative" : "neutral",
      icon: TrendingUp,
    },
    {
      label: "Win Rate",
      value: `${myWinRate.toFixed(1)}%`,
      change: myWinRate > 50 ? "Good" : "Work on it",
      changeType: myWinRate > 50 ? "positive" : "neutral",
      icon: Target,
    },
    {
      label: "Trade Volume",
      value: `${myVolume.toFixed(2)} SOL`,
      change: "Only my flow",
      icon: BarChart3,
    },
    {
      label: "Trade Fees",
      value: `${myTradeFees.toFixed(4)} SOL`,
      change: "My trades only",
      icon: Zap,
    },
    {
      label: "Avg Hold Time",
      value: `${myAvgHold.toFixed(0)} min`,
      change: myAvgHold > 0 ? "scalping" : "N/A",
      changeType: myAvgHold < 60 ? "positive" : "neutral",
      icon: Clock,
    },
  ];

  if (isMobile) {
    return (
      <div data-tag="page.trade-dashboard" className="w-full max-w-[1400px] mx-auto space-y-5 py-6">
        <section className="surface-panel-hero p-5">
          <div className="inline-flex items-center gap-2 rounded-full border border-bg-border/70 bg-white/5 px-3 py-1 text-xs font-semibold text-white">
            <Sparkles className="w-3.5 h-3.5" /> Mobile trade summary
          </div>
          <h1 className="mt-3 text-2xl font-bold text-white">Trading Analytics</h1>
          <p className="mt-1 text-sm text-white/50">На телефоне показываю только ключевые показатели без тяжёлых графиков.</p>
          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs text-white/40 uppercase tracking-wider">Period:</span>
            <PeriodSelector active={period} onChange={setPeriod} />
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3">
          {metrics.map((metric) => (
            <MetricCard key={metric.label} metric={metric} />
          ))}
        </section>

        <section className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white">Quick stats</h2>
              <p className="text-xs text-white/40 mt-1">Fast mobile view</p>
            </div>
            <Target className="w-5 h-5 text-white/30" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <MobileStat label="Wallets" value={`${myWalletsUsed}`} />
            <MobileStat label="Avg Hold" value={`${myAvgHold.toFixed(0)} min`} />
            <MobileStat label="Fees" value={`${myTradeFees.toFixed(4)} SOL`} />
            <MobileStat label="Best Trade" value={`+${myBestTrade.toFixed(3)} SOL`} />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div data-tag="page.trade-dashboard" className="w-full max-w-[1480px] mx-auto space-y-6 py-6">
      <section className="surface-panel-hero relative overflow-hidden p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-content-muted">
              <Sparkles className="w-3.5 h-3.5" />
              My Trade Dashboard
            </div>
            <h1 className="mt-3 text-2xl md:text-3xl font-bold text-content">Trading Analytics</h1>
            <p className="mt-1 text-sm text-content-muted">Only my trades, my PnL, my wallets. No external wallets or coins.</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-faint uppercase tracking-wider">Period:</span>
            <PeriodSelector active={period} onChange={setPeriod} />
          </div>
        </div>
      </section>

      {/* PnL Card */}
      <section className="surface-panel-hero p-6">
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          <div className="flex-1">
            <div className="text-sm text-content-muted mb-1">Total Realized PnL</div>
            <div className={`text-4xl font-bold ${isProfitable ? "text-[color:var(--theme-primary)]" : myPnl < 0 ? "text-[color:var(--theme-danger)]" : "text-white"}`}>
              {isProfitable ? "+" : ""}
              {myPnl.toFixed(4)} SOL
            </div>
            <div className="text-sm text-content-faint mt-1">${myPnlUsd.toFixed(2)} USD</div>
          </div>
          <div className="flex items-center gap-4">
            {isProfitable ? (
              <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] border border-bg-border/70 text-white">
                <ArrowUpRight className="w-5 h-5" />
                <span className="font-semibold">Profitable</span>
              </div>
            ) : myPnl < 0 ? (
              <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] border border-bg-border/70 text-white">
                <ArrowDownRight className="w-5 h-5" />
                <span className="font-semibold">Loss</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/20 text-white/60">
                <span className="font-semibold text-content">No Trades</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Main Metrics Grid */}
      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} metric={metric} />
        ))}
      </section>

      {/* Detailed Stats */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Trade Stats */}
        <div className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Trade Statistics</h2>
              <p className="text-xs text-white/40 mt-1">Only my trading data</p>
            </div>
            <Activity className="w-5 h-5 text-white/30" />
          </div>
          <div className="space-y-3">
            <StatRow label="Total Trades" value={String(myTrades)} />
            <StatRow label="Winning Trades" value={`${Math.round(myTrades * (myWinRate / 100))} (${myWinRate.toFixed(1)}%)`} highlight={myWinRate > 50} />
            <StatRow label="Losing Trades" value={`${Math.round(myTrades * ((100 - myWinRate) / 100))} (${(100 - myWinRate).toFixed(1)}%)`} />
            <StatRow label="Best Trade" value={`+${myBestTrade.toFixed(3)} SOL`} highlight={myBestTrade > 0} />
            <StatRow label="Avg Trade Size" value={`${myAvgTradeSize.toFixed(2)} SOL`} />
            <StatRow label="Wallets Used" value={`${myWalletsUsed}`} />
          </div>
        </div>

        {/* Performance Metrics */}
        <div className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Performance Metrics</h2>
              <p className="text-xs text-white/40 mt-1">My efficiency only</p>
            </div>
            <Gauge className="w-5 h-5 text-white/30" />
          </div>
          <div className="space-y-4">
            <ProgressBar label="Win Rate" value={myWinRate} max={100} suffix="%" color="purple" />
            <ProgressBar label="Profit Factor" value={myPnl > 0 ? myPnl / Math.max(0.001, myTradeFees) : 0} max={10} suffix="" color="purple" />
            <ProgressBar label="Volume Efficiency" value={myVolume > 0 ? (Math.abs(myPnl) / myVolume) * 100 : 0} max={20} suffix="%" color="purple" />
            
            <div className="pt-3 border-t border-white/10 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-white/50">Fee Impact</span>
                <span className="text-white font-semibold">{myTradeFees.toFixed(4)} SOL</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/50">Net after Fees</span>
                <span className={`font-semibold ${isProfitable ? "text-[color:var(--theme-primary)]" : "text-white"}`}>
                  {(myPnl - myTradeFees).toFixed(4)} SOL
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Charts Section */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* PnL Over Time */}
        <div className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <LineChartIcon className="w-5 h-5 text-white" />
                PnL Over Time
              </h2>
              <p className="text-xs text-white/40 mt-1">My trading profit/loss</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myTrades === 0 ? (
              <EmptyChart message="No trades yet. Start trading to see PnL!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={getChartData("pnl", period)}>
                  <defs>
                    <linearGradient id="colorPnL" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#9945FF" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#9945FF" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1f1f2e" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="#6b6b80" fontSize={10} tickLine={false} axisLine={{ stroke: "#1f1f2e" }} />
                  <YAxis stroke="#6b6b80" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(2)} />
                  <Tooltip
                    contentStyle={{ background: "#0D0D12", border: "1px solid #1f1f2e", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#a0a0b8" }}
                    formatter={(v: number) => [v.toFixed(3) + " SOL", "PnL"]}
                  />
                  <Area type="monotone" dataKey="value" stroke="#9945FF" fillOpacity={1} fill="url(#colorPnL)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Trade Volume */}
        <div className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-white" />
                Trade Volume
              </h2>
              <p className="text-xs text-white/40 mt-1">My trading activity</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myTrades === 0 ? (
              <EmptyChart message="No volume yet. Execute trades to track volume!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={getChartData("volume", period)}>
                  <CartesianGrid stroke="#1f1f2e" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="#6b6b80" fontSize={10} tickLine={false} axisLine={{ stroke: "#1f1f2e" }} />
                  <YAxis stroke="#6b6b80" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(1)} />
                  <Tooltip
                    contentStyle={{ background: "#0D0D12", border: "1px solid #1f1f2e", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#a0a0b8" }}
                    formatter={(v: number) => [v.toFixed(2) + " SOL", "Volume"]}
                  />
                  <Bar dataKey="value" fill="#9945FF" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Win/Loss Distribution */}
        <div className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <PieChart className="w-5 h-5 text-white" />
                Win/Loss Distribution
              </h2>
              <p className="text-xs text-white/40 mt-1">My trade outcomes</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myTrades === 0 ? (
              <EmptyChart message="No trades yet. Start trading to see wins/losses!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <RePieChart>
                  <Pie
                    data={[
                      { name: "Wins", value: Math.round(myTrades * (myWinRate / 100)), color: "#00FF85" },
                      { name: "Losses", value: Math.round(myTrades * ((100 - myWinRate) / 100)), color: "#FF4D6D" },
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    <Cell fill="#00FF85" />
                    <Cell fill="#FF4D6D" />
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: "#0D0D12", border: "1px solid #1f1f2e", borderRadius: 8, fontSize: 12 }}
                  />
                </RePieChart>
              </ResponsiveContainer>
            )}
          </div>
          {myTrades > 0 && (
            <div className="flex justify-center gap-4 mt-2">
              <div className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-full bg-[color:var(--theme-primary)]" />
                <span className="text-white/60">Wins ({Math.round(myTrades * (myWinRate / 100))})</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-full bg-[color:var(--theme-danger)]" />
                <span className="text-white/60">Losses ({Math.round(myTrades * ((100 - myWinRate) / 100))})</span>
              </div>
            </div>
          )}
        </div>

        {/* Fees Chart */}
        <div className="surface-panel rounded-2xl border border-bg-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Zap className="w-5 h-5 text-white" />
                Trading Fees
              </h2>
              <p className="text-xs text-white/40 mt-1">Fee accumulation over time</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myTrades === 0 ? (
              <EmptyChart message="No fees yet. Trade to accumulate fee data!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={getChartData("volume", period)}>
                  <CartesianGrid stroke="#1f1f2e" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="#6b6b80" fontSize={10} tickLine={false} axisLine={{ stroke: "#1f1f2e" }} />
                  <YAxis stroke="#6b6b80" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(3)} />
                  <Tooltip
                    contentStyle={{ background: "#0D0D12", border: "1px solid #1f1f2e", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#a0a0b8" }}
                    formatter={(v: number) => [(v * 0.01).toFixed(3) + " SOL", "Fees"]}
                  />
                  <Line type="monotone" dataKey="value" stroke="#FF4D6D" strokeWidth={2} dot={{ fill: "#FF4D6D", r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* Quick Actions */}
      <section className="flex flex-wrap gap-3">
        <Link
          href="/trade/analysis"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[color:var(--theme-primary)] text-[color:var(--theme-content-inverted)] font-semibold text-sm transition"
        >
          <BarChart3 className="w-4 h-4" />
          Analyze Token
          <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href="/cto-wallets"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/20 text-white font-semibold text-sm hover:bg-white/5 transition"
        >
          <Wallet className="w-4 h-4" />
          My Wallets
        </Link>
      </section>
    </div>
  );
}

function MetricCard({ metric }: { metric: TradeMetric }) {
  const Icon = metric.icon;
  return (
    <div className="surface-panel rounded-xl border border-bg-border p-4 hover:border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)] transition">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-white/40">{metric.label}</span>
        <Icon className="w-4 h-4 text-white/30" />
      </div>
      <div className="text-2xl font-bold text-white">{metric.value}</div>
      {metric.change && (
        <div
          className={`text-xs mt-1 ${
            metric.changeType === "positive"
              ? "text-[color:var(--theme-primary)]"
              : metric.changeType === "negative"
              ? "text-[color:var(--theme-danger)]"
              : "text-white/40"
          }`}
        >
          {metric.change}
        </div>
      )}
    </div>
  );
}

function MobileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

function StatRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span className="text-sm text-white/60">{label}</span>
      <span className={`text-sm font-semibold ${highlight ? "text-[color:var(--theme-primary)]" : "text-white"}`}>{value}</span>
    </div>
  );
}

function ProgressBar({ label, value, max, suffix, color = "green" }: { label: string; value: number; max: number; suffix: string; color?: "green" | "purple" }) {
  const pct = Math.min(100, Math.max(0, (Math.min(value, max) / max) * 100));
  const colorClass = color === "purple"
    ? "from-[color:var(--theme-secondary)] to-[color-mix(in_srgb,var(--theme-secondary)_60%,transparent)]"
    : "from-[color:var(--theme-primary)] to-[color-mix(in_srgb,var(--theme-primary)_60%,transparent)]";
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-white/60">{label}</span>
        <span className="text-white font-medium">
          {value.toFixed(value > 10 ? 0 : 1)}
          {suffix}
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-white/30">
      <BarChart3 className="w-12 h-12 mb-3 opacity-20" />
      <p className="text-sm text-center">{message}</p>
      <p className="text-xs mt-1">All metrics start at 0</p>
    </div>
  );
}

