"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Rocket,
  Package,
  Wallet,
  Zap,
  ShieldCheck,
  TrendingUp,
  Clock,
  Target,
  Sparkles,
  ChevronRight,
  BarChart3,
  PieChart,
  Activity,
} from "lucide-react";
import PeriodSelector, { type Period } from "@/components/PeriodSelector";
import { getPeriodStats, getChartData } from "@/lib/mockData";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, PieChart as RePieChart, Pie, Cell } from "recharts";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

// РўРѕР»СЊРєРѕ РјРѕРё launch РјРµС‚СЂРёРєРё
const LAUNCH_PERIODS = ["1H", "1D", "7D", "30D", "90D", "1Y", "ALL"] as const;

type LaunchMetric = {
  label: string;
  value: string;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  icon: typeof Rocket;
};

const premiumSurface =
  "surface-panel rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] shadow-[0_18px_55px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md";

const premiumHero =
  "surface-panel-hero relative overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(0,255,133,0.12),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] shadow-[0_24px_80px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md";

export default function LaunchDashboardPage() {
  const [period, setPeriod] = useState<Period>("30D");
  const isMobile = useIsMobileViewport();
  const stats = useMemo(() => getPeriodStats(period), [period]);

  // РўРѕР»СЊРєРѕ РјРѕРё launches - РЅРµ С‡СѓР¶РёРµ!
  const myLaunches = stats.tokensCreated;
  const myMigrations = stats.migrations;
  const myAvgAth = stats.averageAthUsd;
  const myLaunchFees = stats.launchFeesSol;
  const myActiveTokens = stats.activeTokens;
  const mySuccessfulLaunches = stats.successfulLaunches;
  const myMigrationRate = stats.migrationRate * 100;

  const metrics: LaunchMetric[] = [
    {
      label: "My Launches",
      value: String(myLaunches),
      change: period,
      icon: Rocket,
    },
    {
      label: "Active Tokens",
      value: String(myActiveTokens),
      change: myActiveTokens > 0 ? "Live" : "None",
      changeType: myActiveTokens > 0 ? "positive" : "neutral",
      icon: Target,
    },
    {
      label: "Average ATH",
      value: myAvgAth > 0 ? `$${myAvgAth.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$0",
      change: "Only my tokens",
      icon: TrendingUp,
    },
    {
      label: "Migrations",
      value: String(myMigrations),
      change: `${myMigrationRate.toFixed(0)}% rate`,
      changeType: myMigrationRate > 30 ? "positive" : "neutral",
      icon: ShieldCheck,
    },
    {
      label: "Launch Fees",
      value: `${myLaunchFees.toFixed(4)} SOL`,
      change: "Only my launches",
      icon: Zap,
    },
    {
      label: "Success Rate",
      value: `${mySuccessfulLaunches}/${myLaunches}`,
      change: myLaunches > 0 ? `${((mySuccessfulLaunches / myLaunches) * 100).toFixed(0)}%` : "0%",
      changeType: mySuccessfulLaunches > 0 ? "positive" : "neutral",
      icon: Wallet,
    },
  ];

  if (isMobile) {
    return (
      <div data-tag="page.launch-dashboard" className="relative isolate overflow-hidden w-full max-w-[1400px] mx-auto space-y-5 py-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,255,133,0.08),transparent_28%),radial-gradient(circle_at_80%_20%,rgba(153,69,255,0.08),transparent_24%)]" />
        <section className={`${premiumHero} p-5`}>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
            <Sparkles className="w-3.5 h-3.5" /> Mobile launch summary
          </div>
          <h1 className="mt-3 text-2xl font-bold text-white">Token Launch Analytics</h1>
          <p className="mt-1 text-sm text-white/50">Быстрый режим для телефона: только основные launch-метрики без тяжёлых графиков.</p>
          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs text-white/40 uppercase tracking-wider">Period:</span>
            <PeriodSelector active={period} onChange={setPeriod} />
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3">
          {metrics.slice(0, 4).map((metric) => (
            <MetricCard key={metric.label} metric={metric} />
          ))}
        </section>

        <section className="grid grid-cols-1 gap-3">
          <Link href="/token-launch/new" className="inline-flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(0,0,0,0.16)] transition-transform duration-300 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]">
            <span>Start new bundle</span>
            <ChevronRight className="w-4 h-4" />
          </Link>
          <Link href="/launch-dashboard" className="inline-flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(0,0,0,0.16)] transition-transform duration-300 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]">
            <span>Refresh launch stats</span>
            <ChevronRight className="w-4 h-4" />
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div data-tag="page.launch-dashboard" className="relative isolate overflow-hidden w-full max-w-[1480px] mx-auto space-y-6 py-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(0,255,133,0.07),transparent_24%),radial-gradient(circle_at_top_right,rgba(153,69,255,0.08),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.01),transparent_18%)]" />
      <section className={`${premiumHero} p-6`}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs font-semibold text-content-muted shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
              <Sparkles className="w-3.5 h-3.5" />
              My Launch Dashboard
            </div>
            <h1 className="mt-3 text-2xl md:text-3xl font-bold text-white">Token Launch Analytics</h1>
            <p className="mt-1 text-sm text-white/55">Only my launches, my tokens, my wallets. No external data.</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/40 uppercase tracking-wider">Period:</span>
            <PeriodSelector active={period} onChange={setPeriod} />
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
        {/* Launch Timeline */}
        <div className={`${premiumSurface} p-5 transition-transform duration-300 hover:-translate-y-0.5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">My Launch Timeline</h2>
              <p className="text-xs text-white/45 mt-1">Only my token launches</p>
            </div>
            <Clock className="w-5 h-5 text-white/25" />
          </div>
          <div className="space-y-3">
            {myLaunches === 0 ? (
              <div className="text-center py-8 text-white/40 text-sm">
                No launches in selected period
              </div>
            ) : (
              <>
                <TimelineRow label="First Launch" value={myLaunches > 0 ? "Yes" : "No"} active={myLaunches > 0} />
                <TimelineRow label="Active Now" value={`${myActiveTokens} tokens`} active={myActiveTokens > 0} />
                <TimelineRow label="Migrated" value={`${myMigrations} tokens`} active={myMigrations > 0} />
                <TimelineRow label="Dead/Rug" value={`${myLaunches - myActiveTokens - myMigrations} tokens`} active={myLaunches > myActiveTokens + myMigrations} />
              </>
            )}
          </div>
        </div>

        {/* Performance Breakdown */}
        <div className={`${premiumSurface} p-5 transition-transform duration-300 hover:-translate-y-0.5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Performance Breakdown</h2>
              <p className="text-xs text-white/45 mt-1">Only my metrics</p>
            </div>
            <TrendingUp className="w-5 h-5 text-white/25" />
          </div>
          <div className="space-y-4">
            <ProgressBar label="Migration Rate" value={myMigrationRate} max={100} suffix="%" />
            <ProgressBar label="Success Rate (>$100k ATH)" value={myLaunches > 0 ? (mySuccessfulLaunches / myLaunches) * 100 : 0} max={100} suffix="%" />
            <ProgressBar label="Active Tokens" value={myLaunches > 0 ? (myActiveTokens / myLaunches) * 100 : 0} max={100} suffix="%" />
              <div className="pt-3 border-t border-white/10">
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Total Volume</span>
                  <span className="text-white font-semibold">{stats.tradingVolume.sol.toFixed(2)} SOL</span>
                </div>
              <div className="flex justify-between text-sm mt-2">
                <span className="text-white/50">Fees Paid</span>
                <span className="text-white font-semibold">{stats.feesPaid.sol.toFixed(4)} SOL</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Charts Section */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Launches Over Time */}
        <div className={`${premiumSurface} p-5 transition-transform duration-300 hover:-translate-y-0.5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-white" />
                Launches Over Time
              </h2>
              <p className="text-xs text-white/45 mt-1">My token launches by period</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myLaunches === 0 ? (
              <EmptyChart message="No launches yet. Start creating tokens!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={getChartData("volume", period)}>
                  <defs>
                    <linearGradient id="launch-volume-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00FF85" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#00FF85" stopOpacity={0.18} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="#8e93a8" fontSize={10} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} />
                  <YAxis stroke="#8e93a8" fontSize={10} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(10,12,18,0.92)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 12,
                      fontSize: 12,
                      boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
                      backdropFilter: "blur(12px)",
                    }}
                    labelStyle={{ color: "#c7cada" }}
                    formatter={(v: number) => [v.toFixed(2) + " SOL", "Volume"]}
                  />
                  <Bar dataKey="value" fill="url(#launch-volume-gradient)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* ATH Progression - РєР°Р¶РґС‹Р№ С‚РѕРєРµРЅ РѕС‚РґРµР»СЊРЅРѕ РЅР° РѕСЃРё X */}
        <div className={`${premiumSurface} p-5 transition-transform duration-300 hover:-translate-y-0.5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-white" />
                ATH by Token
              </h2>
              <p className="text-xs text-white/45 mt-1">1 token = 1 value (sorted by ATH)</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myLaunches === 0 ? (
              <EmptyChart message="No ATH data yet. Launch tokens to see growth!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={getChartData("ath", period)} layout="vertical">
                  <defs>
                    <linearGradient id="launch-ath-gradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#9945FF" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#00FF85" stopOpacity={0.9} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" horizontal={true} vertical={false} />
                  <XAxis type="number" stroke="#8e93a8" fontSize={10} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickFormatter={(v) => "$" + (v / 1000) + "k"} />
                  <YAxis dataKey="date" type="category" stroke="#8e93a8" fontSize={10} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} width={60} />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(10,12,18,0.92)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 12,
                      fontSize: 12,
                      boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
                      backdropFilter: "blur(12px)",
                    }}
                    labelStyle={{ color: "#c7cada" }}
                    formatter={(v: number) => ["$" + v.toLocaleString(), "ATH"]}
                    labelFormatter={(label) => `Token: ${label}`}
                  />
                  <Bar dataKey="value" fill="url(#launch-ath-gradient)" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Token Status Distribution */}
        <div className={`${premiumSurface} p-5 transition-transform duration-300 hover:-translate-y-0.5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <PieChart className="w-5 h-5 text-white" />
                Token Status
              </h2>
              <p className="text-xs text-white/45 mt-1">Active / Migrated / Dead</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myLaunches === 0 ? (
              <EmptyChart message="No tokens yet. Create your first launch!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <RePieChart>
                  <Pie
                    data={[
                      { name: "Active", value: myActiveTokens, color: "#00FF85" },
                      { name: "Migrated", value: myMigrations, color: "#9945FF" },
                      { name: "Dead", value: myLaunches - myActiveTokens - myMigrations, color: "#FF4D6D" },
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    style={{ filter: "drop-shadow(0px 10px 18px rgba(0,0,0,0.35))" }}
                  >
                    <Cell fill="#00FF85" />
                    <Cell fill="#9945FF" />
                    <Cell fill="#FF4D6D" />
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "rgba(10,12,18,0.92)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 12,
                      fontSize: 12,
                      boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
                      backdropFilter: "blur(12px)",
                    }}
                  />
                </RePieChart>
              </ResponsiveContainer>
            )}
          </div>
          {myLaunches > 0 && (
            <div className="flex justify-center gap-4 mt-2">
              <div className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-full bg-[color:var(--theme-primary)]" />
                <span className="text-white/60">Active ({myActiveTokens})</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-full bg-[color:var(--theme-secondary)]" />
                <span className="text-white/60">Migrated ({myMigrations})</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-full bg-[color:var(--theme-warning)]" />
                <span className="text-white/60">Dead ({myLaunches - myActiveTokens - myMigrations})</span>
              </div>
            </div>
          )}
        </div>

        {/* Fees & Budget */}
        <div className={`${premiumSurface} p-5 transition-transform duration-300 hover:-translate-y-0.5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Zap className="w-5 h-5 text-white" />
                Fees & Budget
              </h2>
              <p className="text-xs text-white/45 mt-1">Launch costs over time</p>
            </div>
          </div>
          <div className="h-[200px]">
            {myLaunches === 0 ? (
              <EmptyChart message="No fees yet. Launch tokens to track costs!" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={getChartData("volume", period)}>
                  <defs>
                    <linearGradient id="launch-budget-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#9945FF" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#9945FF" stopOpacity={0.18} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="#8e93a8" fontSize={10} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} />
                  <YAxis stroke="#8e93a8" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(2)} />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(10,12,18,0.92)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 12,
                      fontSize: 12,
                      boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
                      backdropFilter: "blur(12px)",
                    }}
                    labelStyle={{ color: "#c7cada" }}
                    formatter={(v: number) => [v.toFixed(3) + " SOL", "Budget"]}
                  />
                  <Bar dataKey="value" fill="url(#launch-budget-gradient)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* Quick Actions */}
      <section className="flex flex-wrap gap-3">
        <Link
          href="/token-launch/new"
          className="inline-flex items-center gap-2 rounded-full border border-transparent bg-[linear-gradient(135deg,rgba(0,255,133,0.95),rgba(0,255,133,0.72))] px-4 py-2.5 text-sm font-semibold text-[#08110d] shadow-[0_12px_30px_rgba(0,255,133,0.18)] transition-transform duration-300 hover:-translate-y-0.5 active:scale-[0.99]"
        >
          <Rocket className="w-4 h-4" />
          New Launch
          <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href="/bundles"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(0,0,0,0.16)] transition-transform duration-300 hover:-translate-y-0.5 hover:bg-white/[0.08] active:scale-[0.99]"
        >
          <Package className="w-4 h-4" />
          My Bundles
        </Link>
      </section>
    </div>
  );
}

function MetricCard({ metric }: { metric: LaunchMetric }) {
  const Icon = metric.icon;
  return (
    <div className="group surface-panel rounded-[20px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] p-4 shadow-[0_16px_44px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--theme-primary)_28%,transparent)]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-white/42">{metric.label}</span>
        <div className="rounded-full border border-white/10 bg-white/[0.05] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <Icon className="w-4 h-4 text-white/35 transition-colors duration-300 group-hover:text-white" />
        </div>
      </div>
      <div className="text-2xl font-bold text-white tracking-tight">{metric.value}</div>
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

function TimelineRow({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span className="text-sm text-white/62">{label}</span>
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-semibold transition-colors duration-300 ${
          active
            ? "bg-[color-mix(in_srgb,var(--theme-primary)_12%,transparent)] text-[color:var(--theme-primary)] shadow-[0_0_0_1px_rgba(0,255,133,0.08)]"
            : "text-white/42"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ProgressBar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-white/62">{label}</span>
        <span className="text-white/90 font-medium">
          {value.toFixed(1)}
          {suffix}
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[color:var(--theme-primary)] via-[color-mix(in_srgb,var(--theme-primary)_80%,white_8%)] to-[color-mix(in_srgb,var(--theme-primary)_55%,transparent)] shadow-[0_0_18px_rgba(0,255,133,0.22)] transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-white/28 rounded-2xl border border-dashed border-white/10 bg-white/[0.02]">
      <BarChart3 className="w-12 h-12 mb-3 opacity-20" />
      <p className="text-sm text-center text-white/55">{message}</p>
      <p className="text-xs mt-1 text-white/32">All metrics start at 0</p>
    </div>
  );
}

