"use client";
import React, { useEffect, useState, useMemo } from "react";
import { TabLoading, TabError, TabEmpty, shortAddr, fmtNum } from "./_shared";
import AnalyticsTab from "./AnalyticsTab";
import { Users, AlertTriangle, Crown, Link as LinkIcon, Clock, DollarSign, BarChart3, PieChart, Activity, Target, TrendingUp } from "lucide-react";
import { PieChart as RePieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Line, Area, ComposedChart } from "recharts";
import { loadPageState, savePageState } from "@/lib/pageState";

// Import types from API
interface TokenForensics {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number | null;
  lastActiveAt: number | null;
  lifespanHours: number | null;
  lifespanMinutes: number | null;
  networkVolumeMAt_launch: number | null;
  pumpFunVolumeMAt_launch: number | null;
  tokenVolumeSol: number | null;
  tokenVolumeUsd: number | null;
  isMigrated: boolean;
  athUsd: number | null;
  peakMarketCap: number | null;
  historicalPeakMCAP?: number | null;
  creatorFeesUsd?: number | null;
  totalFeesSol?: number | null;
  totalFeesUsd?: number | null;
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

interface ForensicsResult {
  creator: string;
  totalCreatedTokens: number;
  totalMigratedTokens: number;
  migrationRate: number;
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
  volumeCorrelation: Array<{
    label: string;
    minM: number;
    maxM: number;
    tokenCount: number;
    migrationRate: number;
    avgAthUsd: number;
  }>;
  optimalVolumeRangeM: { min: number; max: number } | null;
  currentNetworkVolumeM: number | null;
  isOptimalLaunchTime: boolean;
  bestToken: TokenForensics | null;
  worstToken: TokenForensics | null;
  successRate: number;
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

interface Props {
  mint: string;
}

const getDevForensicsStateKey = (mint: string) => `chart.dev-forensics.v12:${mint}`;

function formatUsd(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4)}`;
}

function getTokenMcapAth(token: TokenForensics): number {
  return Math.max(token.historicalPeakMCAP || 0, token.peakMarketCap || 0, token.athUsd || 0);
}

function formatTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}м`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}ч`;
  return `${Math.round(minutes / 1440)}д`;
}

// Simple SVG Donut Chart
function DonutChart({ data, size = 120 }: { data: Array<{ label: string; value: number; color: string }>; size?: number }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return null;

  let cumulative = 0;
  const paths = data.map((item) => {
    const percentage = item.value / total;
    const startAngle = cumulative * 360;
    const endAngle = (cumulative + percentage) * 360;
    cumulative += percentage;

    const startAngleRad = (startAngle * Math.PI) / 180;
    const endAngleRad = (endAngle * Math.PI) / 180;

    const x1 = 50 + 40 * Math.cos(startAngleRad);
    const y1 = 50 + 40 * Math.sin(startAngleRad);
    const x2 = 50 + 40 * Math.cos(endAngleRad);
    const y2 = 50 + 40 * Math.sin(endAngleRad);

    const largeArc = percentage > 0.5 ? 1 : 0;

    return `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2} Z`;
  });

  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {paths.map((path, i) => (
        <path key={i} d={path} fill={data[i].color} stroke="white" strokeWidth="2" />
      ))}
      <circle cx="50" cy="50" r="25" fill="white" />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="middle" fontSize="14" fontWeight="bold">
        {total}
      </text>
    </svg>
  );
}

// Beautiful stat card component
function StatCard({ 
  icon: Icon, 
  title, 
  value, 
  subtitle, 
  color = "blue", 
  trend 
}: { 
  icon: any; 
  title: string; 
  value: string | number; 
  subtitle?: string; 
  color?: "blue" | "green" | "red" | "purple" | "orange";
  trend?: "up" | "down" | "neutral";
}) {
  const colorClasses = {
    blue: "from-blue-500/20 to-blue-600/20 border-blue-500/30 text-blue-400",
    green: "from-green-500/20 to-green-600/20 border-green-500/30 text-green-400",
    red: "from-red-500/20 to-red-600/20 border-red-500/30 text-red-400",
    purple: "from-purple-500/20 to-purple-600/20 border-purple-500/30 text-purple-400",
    orange: "from-orange-500/20 to-orange-600/20 border-orange-500/30 text-orange-400",
  };

  return (
    <div className={`relative overflow-hidden rounded-xl border bg-gradient-to-br ${colorClasses[color]} p-4 transition-all hover:scale-105`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs font-medium opacity-70">{title}</p>
          <p className="mt-1 text-2xl font-bold">{value}</p>
          {subtitle && <p className="mt-1 text-xs opacity-70">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 opacity-70" />
        </div>
      </div>
    </div>
  );
}

// Custom tooltip for charts
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-3 shadow-xl">
        <p className="text-sm font-medium text-gray-200">{label}</p>
        {payload.map((entry: any, index: number) => (
          <p key={index} className="text-sm" style={{ color: entry.color }}>
            {entry.name}: {entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

// Migration pie chart with Recharts
function MigrationPieChart({ migrationRate }: { migrationRate: number }) {
  const data = [
    { name: 'Мигрировали', value: migrationRate, color: '#10b981' },
    { name: 'Не мигрировали', value: 100 - migrationRate, color: '#ef4444' }
  ];

  return (
    <div className="relative h-[132px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RePieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={42}
            outerRadius={58}
            paddingAngle={3}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={2}
            dataKey="value"
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
        </RePieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-xl font-black text-white">{migrationRate.toFixed(0)}%</div>
        <div className="text-[9px] uppercase tracking-wide text-gray-500">migrated</div>
      </div>
    </div>
  );
}

// Token lifetime distribution chart
function LifetimeDistributionChart({ data }: { data: any }) {
  const chartData = [
    { name: '< 5 мин', value: data.under5m, color: '#ef4444' },
    { name: '5-30 мин', value: data.from5mTo30m, color: '#f97316' },
    { name: '30 мин - 2 ч', value: data.from30mTo2h, color: '#eab308' },
    { name: '2-24 ч', value: data.from2hTo24h, color: '#22c55e' },
    { name: '> 24 ч', value: data.over24h, color: '#3b82f6' }
  ].filter(item => item.value > 0);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
        <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 12 }} />
        <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="value" radius={[8, 8, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function TokenTimelineChart({ tokens }: { tokens: TokenForensics[] }) {
  const adaptMetric = (value: number, max: number) => {
    if (value <= 0 || max <= 0) return 0;
    return Math.round((Math.log10(value + 1) / Math.log10(max + 1)) * 100);
  };

  const maxMCAP = Math.max(...tokens.map(getTokenMcapAth), 1);
  const maxLifespan = Math.max(...tokens.map(t => t.lifespanMinutes || 0), 1);
  const maxVolume = Math.max(...tokens.map(t => t.tokenVolumeUsd || 0), 1);
  const maxFees = Math.max(...tokens.map(t => t.creatorFeesUsd || 0), 1);

  const chartData = [...tokens]
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((token, index) => ({
      token: token.symbol,
      tokenIndex: index + 1,
      tokenLabel: `#${index + 1}`,
      createdAt: token.createdAt || 0,
      createdLabel: token.createdAt
        ? new Date(token.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        : token.symbol,
      MCAP: adaptMetric(getTokenMcapAth(token), maxMCAP),
      Lifespan: adaptMetric(token.lifespanMinutes || 0, maxLifespan),
      Volume: adaptMetric(token.tokenVolumeUsd || 0, maxVolume),
      Fees: adaptMetric(token.creatorFeesUsd || 0, maxFees),
      rawMCAP: getTokenMcapAth(token),
      rawLifespan: token.lifespanMinutes || 0,
      rawVolume: token.tokenVolumeUsd || 0,
      rawFees: token.creatorFeesUsd || 0,
    }));

  const TimelineTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload;
    return (
      <div className="rounded-xl border border-white/10 bg-[#090912]/95 p-3 shadow-2xl backdrop-blur-md">
        <div className="mb-1 text-xs font-bold text-white">{row.token}</div>
        <div className="mb-2 text-[10px] text-gray-500">Токен {label} · {row.createdLabel}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
          <div className="text-emerald-300">MCAP: {formatUsd(row.rawMCAP)} · {row.MCAP}/100</div>
          <div className="text-amber-300">Life: {row.rawLifespan ? formatTime(row.rawLifespan) : "N/A"} · {row.Lifespan}/100</div>
          <div className="text-violet-300">Vol: {formatUsd(row.rawVolume)} · {row.Volume}/100</div>
          <div className="text-rose-300">Fees: {formatUsd(row.rawFees)} · {row.Fees}/100</div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-[250px] rounded-xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(168,85,247,0.13),transparent_38%),rgba(0,0,0,0.22)] px-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 12, left: -18, bottom: 8 }}>
          <defs>
            <linearGradient id="tokenMetricArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 6" stroke="#243041" vertical={false} />
          <XAxis
            dataKey="tokenLabel"
            tick={{ fill: "#64748b", fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            minTickGap={18}
            label={{ value: "Количество токенов", position: "insideBottom", offset: -5, fill: "#64748b", fontSize: 10 }}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fill: "#64748b", fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            width={34}
            label={{ value: "Метрики 0–100", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 10, dy: 38 }}
          />
          <Tooltip content={<TimelineTooltip />} />
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 10, paddingTop: 6, color: "#94a3b8" }}
          />
          <Area type="monotone" dataKey="Volume" name="Volume area" fill="url(#tokenMetricArea)" stroke="transparent" dot={false} legendType="none" />
          <Line type="monotone" dataKey="MCAP" name="MCAP" stroke="#34d399" strokeWidth={2.2} dot={{ r: 2.4, fill: "#34d399", strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="Lifespan" name="Life" stroke="#fbbf24" strokeWidth={2.2} dot={{ r: 2.4, fill: "#fbbf24", strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="Volume" name="Volume" stroke="#a78bfa" strokeWidth={2.2} dot={{ r: 2.4, fill: "#a78bfa", strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="Fees" name="Fees" stroke="#fb7185" strokeWidth={2} dot={{ r: 2.2, fill: "#fb7185", strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function DevForensicsTab({ mint }: Props) {
  const [data, setData] = useState<ForensicsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const restored = loadPageState<ForensicsResult | null>(getDevForensicsStateKey(mint), null);
    if (restored) {
      setData(restored);
      setLoading(false);
      setErr(null);
    } else {
      setData(null);
      setLoading(true);
      setErr(null);
    }
  }, [mint]);

  const loadForensics = async () => {
    try {
      setLoading(true);
      setErr(null);
      
      const params = new URLSearchParams();
      params.append("mint", mint);
      
      const res = await fetch(`/api/trade/dev-forensics?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      });
      
      if (!res.ok) {
        throw new Error(`Ошибка загрузки: ${res.status}`);
      }
      
      const result = await res.json();
      setData(result);
      savePageState(getDevForensicsStateKey(mint), result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Неизвестная ошибка";
      setErr(message.includes("timed out") ? "API не успел ответить. Попробуйте обновить через несколько секунд." : message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!mint) return;
    const restored = loadPageState<ForensicsResult | null>(getDevForensicsStateKey(mint), null);
    if (!restored) loadForensics();
  }, [mint]);

  const chartData = useMemo(() => {
    if (!data) return [];
    
    return [
      { label: "Создано", value: data.totalCreatedTokens - data.totalMigratedTokens, color: "#ef4444" },
      { label: "Мигрировало", value: data.totalMigratedTokens, color: "#22c55e" },
    ];
  }, [data]);

  const lifetimeChartData = useMemo(() => {
    if (!data) return [];
    
    return [
      { label: "< 5м", value: data.lifetimeDistribution.under5m, color: "#dc2626" },
      { label: "5-30м", value: data.lifetimeDistribution.from5mTo30m, color: "#f97316" },
      { label: "30м-2ч", value: data.lifetimeDistribution.from30mTo2h, color: "#eab308" },
      { label: "2ч-24ч", value: data.lifetimeDistribution.from2hTo24h, color: "#84cc16" },
      { label: "> 24ч", value: data.lifetimeDistribution.over24h, color: "#22c55e" },
    ];
  }, [data]);

  const tokenAverages = useMemo(() => {
    if (!data) {
      return {
        mcapAth: 0,
        lifespanMinutes: 0,
        tokenVolumeUsd: 0,
        creatorFeesUsd: 0,
        resolvedTokenVolumeCount: 0,
        resolvedCreatorFeesCount: 0,
      };
    }

    const tokens = data.tokens;
    const mcapAthValues = tokens
      .map(getTokenMcapAth)
      .filter((value) => value > 0);
    const count = tokens.length > 0 ? tokens.length : 1;

    return {
      mcapAth: mcapAthValues.length > 0 ? mcapAthValues.reduce((sum, value) => sum + value, 0) / mcapAthValues.length : 0,
      lifespanMinutes: tokens.reduce((sum, token) => sum + (token.lifespanMinutes || 0), 0) / count,
      tokenVolumeUsd: data.averageTokenVolumeUsd,
      creatorFeesUsd: data.averageCreatorFeesUsd,
      resolvedTokenVolumeCount: data.resolvedTokenVolumeCount,
      resolvedCreatorFeesCount: data.resolvedCreatorFeesCount,
    };
  }, [data]);

  if (loading) return <TabLoading />;
  if (err) return <TabError message={`Ошибка загрузки аналитики: ${err}`} />;
  if (!data) return <TabEmpty message="Нет данных для анализа" />;

  const hasResolvedCreator = Boolean(data.creator && data.creator !== "unknown");

  return (
    <div className="p-4 space-y-6 text-white">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <BarChart3 className="w-5 h-5" />
          Dev Forensics Analytics
        </h2>
        <div className="text-sm text-gray-400">
          {hasResolvedCreator ? shortAddr(data.creator) : "Unknown"}
        </div>
      </div>

      {/* Auto Creator Detection */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs text-gray-400">
              {hasResolvedCreator ? "Dev wallet найден автоматически" : "Dev wallet не найден"}
            </div>
            <div className="mt-1 font-mono text-sm text-blue-300">
              {hasResolvedCreator ? data.creator : "Не удалось определить"}
            </div>
          </div>
          <button
            onClick={() => loadForensics()}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {loading ? "Поиск..." : "Обновить"}
          </button>
        </div>
        {!hasResolvedCreator && (
          <p className="mt-2 text-xs text-yellow-400">
            ⚠️ Dev wallet не найден. Backend уже проверил локальную базу, Solscan, pump.fun и первые сделки.
          </p>
        )}
      </div>

      {/* Key Metrics - Beautiful Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Crown}
          title="Всего создано"
          value={data.totalCreatedTokens}
          subtitle="токенов"
          color="blue"
        />
        
        <StatCard
          icon={TrendingUp}
          title="Мигрировало"
          value={data.totalMigratedTokens}
          subtitle={`${data.migrationRate.toFixed(1)}% rate`}
          color={data.migrationRate > 50 ? "green" : "orange"}
          trend={data.migrationRate > 50 ? "up" : "neutral"}
        />
        
        <StatCard
          icon={Clock}
          title="Среднее время жизни"
          value={data.avgLifespanMinutes ? formatTime(data.avgLifespanMinutes) : "N/A"}
          subtitle="активности"
          color="purple"
        />
        
        <StatCard
          icon={Target}
          title="Success Rate"
          value={`${data.successRate.toFixed(1)}%`}
          subtitle="$100k+ MCAP"
          color={data.successRate > 0 ? "green" : "red"}
          trend={data.successRate > 0 ? "up" : "down"}
        />
      </div>

      {/* Beautiful Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Migration Rate Pie Chart */}
        <div className="bg-gradient-to-br from-gray-900/80 via-gray-900/50 to-black/30 backdrop-blur-sm rounded-xl p-4 border border-white/10 shadow-lg">
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-gray-100">
            <Activity className="w-4 h-4 text-purple-400" />
            Migration Rate
          </h3>
          <div className="flex flex-col items-center">
            <MigrationPieChart migrationRate={data.migrationRate} />
            <div className="mt-2 grid w-full grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-lg border border-green-500/15 bg-green-500/5 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-green-300">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span>Мигрировали</span>
                </div>
                <div className="mt-0.5 text-sm font-bold text-green-100">{data.totalMigratedTokens}</div>
              </div>
              <div className="rounded-lg border border-red-500/15 bg-red-500/5 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-red-300">
                  <div className="w-2 h-2 rounded-full bg-red-500" />
                  <span>Не мигрировали</span>
                </div>
                <div className="mt-0.5 text-sm font-bold text-red-100">{data.totalCreatedTokens - data.totalMigratedTokens}</div>
              </div>
            </div>
          </div>
        </div>

              </div>

      
      {/* Multi-dimensional Analysis */}
      {data.tokens.length > 0 && (
        <div className="bg-gradient-to-br from-gray-900/80 via-gray-900/50 to-black/30 backdrop-blur-sm rounded-xl p-4 border border-white/10 shadow-lg">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-gray-100">
            <Target className="w-4 h-4 text-orange-400" />
            Многомерный анализ токенов
          </h3>
          <TokenTimelineChart tokens={data.tokens} />
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="rounded-lg border border-green-500/15 bg-green-500/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-green-300">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                Средний MCAP ATH
              </div>
              <div className="mt-1 text-sm font-bold text-green-200">
                {formatUsd(tokenAverages.mcapAth)}
              </div>
            </div>
            <div className="rounded-lg border border-amber-500/15 bg-amber-500/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-amber-300">
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                Среднее время жизни
              </div>
              <div className="mt-1 text-sm font-bold text-amber-200">
                {tokenAverages.lifespanMinutes ? formatTime(tokenAverages.lifespanMinutes) : "N/A"}
              </div>
            </div>
            <div className="rounded-lg border border-purple-500/15 bg-purple-500/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-purple-300">
                <div className="w-2 h-2 rounded-full bg-purple-500" />
                Средний Volume
              </div>
              <div className="mt-1 text-sm font-bold text-purple-200">
                {formatUsd(tokenAverages.tokenVolumeUsd)}
              </div>
              <div className="mt-1 text-[10px] text-purple-300/70">
                Покрытие: {tokenAverages.resolvedTokenVolumeCount}/{data.totalCreatedTokens}
              </div>
            </div>
            <div className="rounded-lg border border-red-500/15 bg-red-500/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-red-300">
                <div className="w-2 h-2 rounded-full bg-red-500" />
                Средние Creator Fees
              </div>
              <div className="mt-1 text-sm font-bold text-red-200">
                {formatUsd(tokenAverages.creatorFeesUsd)}
              </div>
              <div className="mt-1 text-[10px] text-red-300/70">
                Покрытие: {tokenAverages.resolvedCreatorFeesCount}/{data.totalCreatedTokens}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-gradient-to-br from-gray-900/80 via-gray-900/50 to-black/30 backdrop-blur-sm rounded-xl border border-white/10 shadow-lg overflow-hidden">
        <div className="px-4 py-4 border-b border-white/10">
          <h3 className="text-sm font-semibold flex items-center gap-2 text-gray-100">
            <Users className="w-4 h-4 text-cyan-400" />
            Holder & Sybil Intelligence
          </h3>
          <p className="mt-1 text-xs text-gray-400">
            Текущий срез по холдерам, sybil-группам, связям с dev и подозрительным кластерам для этого токена.
          </p>
        </div>
        <AnalyticsTab mint={mint} embedded />
      </div>

      {/* Volume Correlation */}
      {data.volumeCorrelation.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Корреляция с объемом Solana</h3>
          <div className="space-y-2">
            {data.volumeCorrelation.map((bin, i) => (
              <div key={i} className="flex items-center justify-between p-2 bg-gray-700 rounded">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">${bin.minM}M - ${bin.maxM}M</span>
                  <span className="text-xs text-gray-400">{bin.tokenCount} токенов</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm">Migration: {bin.migrationRate.toFixed(1)}%</span>
                  <span className="text-sm">ATH: {bin.avgAthUsd ? formatUsd(bin.avgAthUsd) : "N/A"}</span>
                </div>
              </div>
            ))}
          </div>
          {data.optimalVolumeRangeM && (
            <div className="mt-4 p-3 bg-blue-900/30 rounded border border-blue-500/30">
              <p className="text-sm text-blue-300">
                Оптимальный диапазон для запуска: ${data.optimalVolumeRangeM.min}M - ${data.optimalVolumeRangeM.max}M
              </p>
              {data.currentNetworkVolumeM && (
                <p className="text-sm text-blue-300 mt-1">
                  Текущий объем: ${data.currentNetworkVolumeM.toFixed(0)}M 
                  {data.isOptimalLaunchTime ? " — оптимальное время" : " — неоптимальное время"}
                </p>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

