"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft, Bell, Clock3, ExternalLink, MessageSquareText, Plug, Sparkles, Twitter, TrendingUp, Users } from "lucide-react";

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

type MarketPeriod = "1H" | "6H" | "24H" | "7D" | "30D" | "1Y";

interface MarketOverviewData {
  launched: { total: number; trend: TimeSeriesPoint[] };
  migrated: { total: number; share: number; trend: TimeSeriesPoint[] };
  volume: { totalSol: number; beforeMigration: number; afterMigration: number; trend: TimeSeriesPoint[] };
  traders: { total: number; beforeMigration: number; afterMigration: number; trend: TimeSeriesPoint[] };
  newWallets: { total: number; trend: TimeSeriesPoint[] };
  botFees: { totalSol: number; beforeMigration: number; afterMigration: number; trend: TimeSeriesPoint[] };
  marketCap: { avgUsd: number; avgSol: number; trend: TimeSeriesPoint[] };
  activeTokens: { total: number; trend: TimeSeriesPoint[] };
  twitterSocial: {
    totalAccounts: number;
    totalCommunities: number;
    accountsWithContracts: number;
    memecoinAccounts: number;
    pumpfunMentions: number;
    contractsFound: number;
    createdToday: number;
    created7d: number;
    created30d: number;
    created365d: number;
    discoveredToday: number;
    discovered7d: number;
    discoveryVelocity7d: number;
    topContracts: Array<{ contractAddress: string; accounts: number; mentions: number; lastSeenAt: number | null }>;
    recentDiscoveries: Array<{
      subjectType: "account" | "community";
      handle: string | null;
      displayName: string | null;
      contractAddress: string | null;
      matchedIn: string;
      createdAt: number | null;
      discoveredAt: number;
    }>;
    series: Array<{ timestamp: number; accounts: number; communities: number; contracts: number; memecoinAccounts: number }>;
  };
  meta: {
    source: "sqlite" | "bitquery" | "fallback";
    fallback: boolean;
    reason: string | null;
    updatedAt: number;
    solPriceUsd: number;
    sampledMarketCaps: number;
    bitqueryConfigured: boolean;
    collectorConfigured?: boolean;
  };
}

type TrendCategory = "world" | "crypto" | "solana";

type XTrendsResponse = {
  updatedAt: number;
  categories: Record<TrendCategory, Array<{
    title: string;
    source: string;
    url: string;
    publishedAt: number | null;
    category: TrendCategory;
    score: number;
    tickers: string[];
    keywords: string[];
  }>>;
  hotKeywords: Array<{ keyword: string; count: number; categories: TrendCategory[] }>;
  hotTickers: Array<{ ticker: string; count: number; categories: TrendCategory[] }>;
  memecoins: {
    topGainers: Array<{ symbol: string; name: string; priceUsd: number; change24h: number | null; volumeUsd24h: number; liquidityUsd: number; marketCapUsd: number | null; narrative: string[]; dexUrl: string }>;
    topVolume: Array<{ symbol: string; name: string; priceUsd: number; change24h: number | null; volumeUsd24h: number; liquidityUsd: number; marketCapUsd: number | null; narrative: string[]; dexUrl: string }>;
    solanaMemes: Array<{ symbol: string; name: string; priceUsd: number; change24h: number | null; volumeUsd24h: number; liquidityUsd: number; marketCapUsd: number | null; narrative: string[]; dexUrl: string }>;
    narratives: Array<{ name: string; tokens: string[]; newsCount: number; momentumScore: number; description: string }>;
    fearGreed: { value: number; label: string; updatedAt: number } | null;
    totalMemeVolume24h: number;
    dominantNarrative: string | null;
    momentumShift: "bullish" | "bearish" | "neutral";
  };
};

type ChartRow = {
  label: string;
  launches: number;
  migrated: number;
  volumeBefore: number;
  volumeAfter: number;
  tradersBefore: number;
  tradersAfter: number;
};

type TrendDirection = "up" | "down" | "flat";

const TREND_GREEN = "#22c55e";
const TREND_RED = "#ef4444";

const TIMEFRAME_MAP: Record<MarketPeriod, string> = {
  "1H": "1h",
  "6H": "6h",
  "24H": "24h",
  "7D": "7d",
  "30D": "30d",
  "1Y": "365d",
};

const PERIOD_OPTIONS: { id: MarketPeriod; label: string }[] = [
  { id: "1H", label: "1H" },
  { id: "6H", label: "6H" },
  { id: "24H", label: "1D" },
  { id: "7D", label: "7D" },
  { id: "30D", label: "1M" },
  { id: "1Y", label: "1Y" },
];

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatAxis(value: number): string {
  return formatNumber(value, 0);
}

function resolveTrendDirection(points: Array<{ value: number }>): TrendDirection {
  if (points.length < 2) return "flat";
  const first = points[0]?.value ?? 0;
  const last = points[points.length - 1]?.value ?? first;
  if (last > first) return "up";
  if (last < first) return "down";
  return "flat";
}

function resolveTrendColor(points: Array<{ value: number }>, fallback: string) {
  const direction = resolveTrendDirection(points);
  if (direction === "up") return TREND_GREEN;
  if (direction === "down") return TREND_RED;
  return fallback;
}

function FinanceCandleShape({
  x,
  y,
  width,
  height,
  fill,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
}) {
  if (x == null || y == null || width == null || height == null) return null;
  const candleWidth = Math.max(4, width * 0.54);
  const candleX = x + (width - candleWidth) / 2;
  const candleY = Math.min(y, y + height);
  const candleHeight = Math.max(3, Math.abs(height));
  const wickX = x + width / 2;
  const wickTop = Math.min(y, y + height) - 4;
  const wickBottom = Math.max(y, y + height) + 4;

  return (
    <g>
      <line
        x1={wickX}
        x2={wickX}
        y1={wickTop}
        y2={wickBottom}
        stroke={fill}
        strokeOpacity={0.32}
        strokeWidth={1.2}
      />
      <rect
        x={candleX}
        y={candleY}
        width={candleWidth}
        height={candleHeight}
        rx={candleWidth / 2}
        fill={fill}
        fillOpacity={0.92}
      />
      <rect
        x={candleX}
        y={candleY}
        width={candleWidth}
        height={Math.max(2, candleHeight * 0.28)}
        rx={candleWidth / 2}
        fill="rgba(255,255,255,0.16)"
      />
    </g>
  );
}

function formatDateLabel(timestamp: number, period: MarketPeriod): string {
  const date = new Date(timestamp);
  if (period === "1H" || period === "6H" || period === "24H") {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "numeric" });
}

function makeChartRows(data: MarketOverviewData, period: MarketPeriod): ChartRow[] {
  const volumeBeforeRatio = data.volume.totalSol > 0 ? data.volume.beforeMigration / data.volume.totalSol : 0.48;
  const tradersBeforeRatio = data.traders.total > 0 ? data.traders.beforeMigration / data.traders.total : 0.34;

  return data.launched.trend.map((point, index) => {
    const volume = data.volume.trend[index]?.value ?? 0;
    const traders = data.traders.trend[index]?.value ?? 0;
    return {
      label: formatDateLabel(point.timestamp, period),
      launches: point.value,
      migrated: data.migrated.trend[index]?.value ?? 0,
      volumeBefore: volume * volumeBeforeRatio,
      volumeAfter: volume * (1 - volumeBeforeRatio),
      tradersBefore: traders * tradersBeforeRatio,
      tradersAfter: traders * (1 - tradersBeforeRatio),
    };
  });
}

function sourceLabel(source: MarketOverviewData["meta"]["source"]) {
  if (source === "sqlite") return "local";
  if (source === "bitquery") return "bitquery";
  return "fallback";
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ color?: string; name?: string; value?: number | string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[160px] rounded-xl border border-bg-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--page-accent)_8%,var(--theme-bg-elevated)),color-mix(in_srgb,var(--page-accent-2)_6%,var(--theme-bg-card)))] px-3 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-content-muted">{label}</div>
      <div className="space-y-1.5">
        {payload.map((entry) => (
          <div key={`${entry.name}-${entry.color}`} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex items-center gap-2 text-content-muted">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color ?? "#fff" }} />
              {entry.name}
            </span>
            <span className="font-semibold text-white">{formatNumber(Number(entry.value ?? 0))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PeriodTabs({ active, onChange }: { active: MarketPeriod; onChange: (period: MarketPeriod) => void }) {
  return (
    <div className="surface-panel-hero relative isolate w-full overflow-hidden rounded-[20px] p-3">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--page-glow,var(--theme-primary-soft)),transparent_32%),radial-gradient(circle_at_top_right,var(--page-glow-2,var(--theme-cool-glow)),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.05),transparent_36%)]" />
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--theme-primary)_72%,transparent),transparent)]" />
      <div className="relative mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary-border bg-primary-soft px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.22em] text-content">
            <Sparkles className="h-3 w-3" />
            Time window
          </div>
          <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.24em] text-content-muted">Период анализа</div>
          <div className="mt-0.5 text-[11px] text-white/50">Меняй окно, чтобы увидеть динамику рынка под нужный горизонт</div>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-primary-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-content-muted md:inline-flex">
          <Clock3 className="h-3 w-3" />
          Live view
        </div>
      </div>
      <div className="relative grid grid-cols-3 gap-2 md:grid-cols-6">
        {PERIOD_OPTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-keep-transparent
            onClick={() => onChange(item.id)}
            className={
              item.id === active
                ? "flex h-10 min-w-0 items-center justify-center rounded-[12px] border border-primary-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--page-accent)_20%,var(--theme-bg-elevated)),var(--theme-bg-card))] px-2 text-[10px] font-black uppercase tracking-[0.08em] text-content shadow-[0_0_28px_color-mix(in_srgb,var(--theme-primary)_18%,transparent),0_10px_18px_rgba(0,0,0,0.24)] transition-all duration-200 hover:-translate-y-0.5 md:text-[10px]"
                : "flex h-10 min-w-0 items-center justify-center rounded-[12px] border border-white/10 bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-2 text-[10px] font-bold uppercase tracking-[0.08em] text-content-muted shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03),0_10px_18px_rgba(0,0,0,0.18)] transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-border hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--page-accent-2)_10%,var(--theme-bg-elevated)),var(--theme-bg-card))] hover:text-content md:text-[10px]"
            }
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniSpark({ data, color }: { data: Array<{ value: number }>; color: string }) {
  const gradientId = useId();
  const trendColor = resolveTrendColor(data, color);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 5, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={trendColor} stopOpacity={0.38} />
            <stop offset="100%" stopColor={trendColor} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="value" stroke={trendColor} strokeWidth={2} fill={`url(#${gradientId})`} fillOpacity={1} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function MetricCard({
  label,
  value,
  sub,
  sub2,
  data,
  color,
  warm = false,
}: {
  label: string;
  value: string;
  sub?: string;
  sub2?: string;
  data: Array<{ value: number }>;
  color: string;
  warm?: boolean;
}) {
  const trendDirection = resolveTrendDirection(data);
  const sparkColor = resolveTrendColor(data, color);
  const panelStyle = {
    backgroundImage:
      "linear-gradient(145deg,rgba(34,197,94,0.22),rgba(18,22,21,0.96))",
    borderColor: "rgba(34,197,94,0.34)",
    boxShadow:
      "0 18px 36px rgba(0,0,0,0.22),0 3px 10px rgba(0,0,0,0.16),0 0 24px rgba(34,197,94,0.08)",
  };
  return (
    <div
      className="relative min-h-[92px] overflow-hidden rounded-[16px] border border-bg-border p-3.5 shadow-[0_18px_36px_rgba(0,0,0,0.22),0_3px_10px_rgba(0,0,0,0.16)]"
      style={panelStyle}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,var(--page-glow,var(--theme-primary-soft)),transparent_40%),linear-gradient(135deg,rgba(255,255,255,0.05),transparent_35%)]" />
      <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent)]" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-content-faint">{label}</div>
          <div className="mt-2 text-[17px] font-extrabold leading-none text-white">{value}</div>
          {sub && <div className="mt-2 text-[11px] leading-tight text-content-muted">{sub}</div>}
          {sub2 && <div className="mt-0.5 text-[11px] leading-tight text-content-muted">{sub2}</div>}
        </div>
        <div className="h-10 w-14 shrink-0 rounded-[12px] border border-bg-border bg-[linear-gradient(145deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_16px_rgba(0,0,0,0.18)]">
          <MiniSpark data={data} color={sparkColor} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,var(--page-glow-2,var(--theme-cool-glow)),transparent_44%)]" />
    </div>
  );
}

function TwitterStatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: ReactNode;
}) {
  return (
    <div className="relative min-h-[94px] overflow-hidden rounded-[16px] border border-bg-border bg-[linear-gradient(145deg,rgba(34,197,94,0.20),rgba(18,22,21,0.96))] p-3 shadow-[0_18px_36px_rgba(0,0,0,0.24),0_2px_8px_rgba(2,132,199,0.06)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,197,94,0.12),transparent_40%)]" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-content-faint">{label}</div>
          <div className="mt-2 text-[17px] font-extrabold leading-none text-white">{value}</div>
          <div className="mt-2 text-[11px] leading-tight text-content-muted">{sub}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-bg-border bg-[linear-gradient(180deg,rgba(34,197,94,0.18),rgba(18,22,21,0.96))] text-content shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_18px_rgba(0,0,0,0.18)]">
          {icon}
        </div>
      </div>
    </div>
  );
}

function TwitterListCard({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle: string;
  items: Array<{
    label: string;
    value: string;
    meta?: string;
  }>;
}) {
  return (
    <section className="relative overflow-hidden rounded-[16px] border border-bg-border bg-[linear-gradient(145deg,rgba(34,197,94,0.16),rgba(18,22,21,0.96))] p-3 shadow-[0_20px_42px_rgba(0,0,0,0.24),0_2px_10px_rgba(2,132,199,0.05)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,197,94,0.10),transparent_38%)]" />
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-content">{title}</div>
          <div className="mt-0.5 text-[10px] text-content-muted">{subtitle}</div>
        </div>
        <ExternalLink className="h-4 w-4 shrink-0 text-white/54" />
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={`${item.label}-${item.value}`} className="flex items-start justify-between gap-3 rounded-[10px] border border-bg-border bg-[linear-gradient(145deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-content-faint">{item.label}</div>
          <div className="mt-1 truncate text-[12px] font-semibold text-content">{item.value}</div>
            </div>
            {item.meta ? <div className="text-right text-[10px] leading-tight text-content-muted">{item.meta}</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function TwitterPulseCard({
  trends,
}: {
  trends: XTrendsResponse | null;
}) {
  const series = trends?.memecoins.solanaMemes.slice(0, 8) ?? [];
  const fearGreed = trends?.memecoins.fearGreed;
  return (
    <section className="surface-panel relative overflow-hidden rounded-[16px] p-3 shadow-[0_20px_42px_rgba(0,0,0,0.24),0_2px_10px_rgba(2,132,199,0.05)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--page-accent-2)_14%,transparent),transparent_38%)]" />
      <div className="mb-3">
        <div className="text-[12px] font-semibold text-white">X pulse</div>
        <div className="mt-0.5 text-[10px] text-content-muted">Existing X analysis from the project workspace</div>
      </div>
      <div className="grid gap-2">
        <div className="rounded-[10px] border border-bg-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--page-accent-2)_7%,var(--theme-bg-elevated)),color-mix(in_srgb,var(--page-accent)_4%,var(--theme-bg-card)))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="text-[10px] uppercase tracking-wide text-content-faint">Dominant narrative</div>
          <div className="mt-1 text-[13px] font-semibold text-white">{trends?.memecoins.dominantNarrative || trends?.memecoins.narratives[0]?.name || "No narrative yet"}</div>
        </div>
        <div className="rounded-[10px] border border-bg-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--page-accent-2)_7%,var(--theme-bg-elevated)),color-mix(in_srgb,var(--page-accent)_4%,var(--theme-bg-card)))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="text-[10px] uppercase tracking-wide text-content-faint">Momentum</div>
          <div className="mt-1 text-[13px] font-semibold text-white">{trends?.memecoins.momentumShift ?? "neutral"}</div>
          <div className="mt-1 text-[10px] text-content-muted">
            Meme volume 24h: {trends ? formatNumber(trends.memecoins.totalMemeVolume24h) : "-"}
          </div>
        </div>
        <div className="rounded-[10px] border border-bg-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--page-accent-2)_7%,var(--theme-bg-elevated)),color-mix(in_srgb,var(--page-accent)_4%,var(--theme-bg-card)))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="text-[10px] uppercase tracking-wide text-content-faint">Fear & Greed</div>
          <div className="mt-1 text-[13px] font-semibold text-white">
            {fearGreed ? `${fearGreed.value} / ${fearGreed.label}` : "Unavailable"}
          </div>
        </div>
        <div className="h-28 overflow-hidden rounded-[10px] border border-bg-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--page-accent-2)_7%,var(--theme-bg-elevated)),color-mix(in_srgb,var(--page-accent)_4%,var(--theme-bg-card)))] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_12px_24px_rgba(0,0,0,0.18)]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series.map((item, index) => ({ name: item.symbol, value: item.volumeUsd24h, index }))}
              margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
            >
              <Area type="monotone" dataKey="value" stroke="var(--page-accent-2)" strokeWidth={2} fill="var(--page-accent-2)" fillOpacity={0.12} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function GraphCard({
  title,
  children,
  tone = "green",
  accentColor,
  className = "",
}: {
  title: string;
  children: ReactNode;
  tone?: "green" | "amber";
  accentColor?: string;
  className?: string;
  }) {
  const color = tone === "green" ? "var(--theme-success)" : "var(--theme-danger)";
  const badgeColor = accentColor ?? color;
  return (
    <section className={`surface-panel relative overflow-hidden rounded-[16px] p-3 shadow-[0_26px_65px_rgba(0,0,0,0.34),0_8px_18px_rgba(0,0,0,0.18)] ${className}`}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--page-accent)_12%,transparent),transparent_34%),radial-gradient(circle_at_bottom_left,color-mix(in_srgb,var(--page-accent-2)_10%,transparent),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.04),transparent_32%)]" />
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full shadow-[0_0_18px_currentColor]" style={{ backgroundColor: badgeColor, color: badgeColor }} />
        <h2 className="text-[13px] font-semibold tracking-wide text-content">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-white">{title}</div>
        {subtitle ? <div className="mt-0.5 text-[10px] text-content-muted">{subtitle}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export default function MarketOverviewPage() {
  const [period, setPeriod] = useState<MarketPeriod>("30D");
  const [data, setData] = useState<MarketOverviewData | null>(null);
  const [xTrends, setXTrends] = useState<XTrendsResponse | null>(null);
  const [xTrendsLoading, setXTrendsLoading] = useState(true);
  const [xTrendsError, setXTrendsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/market-overview?timeframe=${TIMEFRAME_MAP[period]}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to fetch market overview");
        if (alive) setData(json as MarketOverviewData);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Failed to fetch market overview");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [period]);

  useEffect(() => {
    let alive = true;

    async function loadXTrends() {
      setXTrendsLoading(true);
      setXTrendsError(null);
      try {
        const res = await fetch("/api/x-analysis/trends?lang=ru", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load X analysis");
        if (alive) setXTrends(json as XTrendsResponse);
      } catch (err) {
        if (alive) setXTrendsError(err instanceof Error ? err.message : "Failed to load X analysis");
      } finally {
        if (alive) setXTrendsLoading(false);
      }
    }

    loadXTrends();
    return () => {
      alive = false;
    };
  }, []);

  const displayedHotKeywords = useMemo(() => {
    if (xTrends?.hotKeywords?.length) return xTrends.hotKeywords.slice(0, 6);
    return (
      xTrends?.memecoins.narratives.map((item) => ({
        keyword: item.name,
        count: item.newsCount || item.momentumScore,
        categories: ["solana"] as TrendCategory[],
      })) ?? []
    ).slice(0, 6);
  }, [xTrends]);

  const displayedHotTickers = useMemo(() => {
    if (xTrends?.hotTickers?.length) return xTrends.hotTickers.slice(0, 6);
    return (
      xTrends?.memecoins.solanaMemes.map((item, index) => ({
        ticker: item.symbol,
        count: Math.max(1, 6 - index),
        categories: ["solana"] as TrendCategory[],
      })) ?? []
    ).slice(0, 6);
  }, [xTrends]);

  const rows = useMemo(() => (data ? makeChartRows(data, period) : []), [data, period]);
  const viewKey = `${period}-${data?.meta.updatedAt ?? "pending"}`;
  const launchTrendColor = resolveTrendColor(rows.map((row) => ({ value: row.launches })), "var(--page-accent)");
  const migratedTrendColor = resolveTrendColor(rows.map((row) => ({ value: row.migrated })), "var(--page-accent-2)");
  const volumeTrendColor = resolveTrendColor(rows.map((row) => ({ value: row.volumeAfter })), "var(--page-accent-2)");
  const tradersTrendColor = resolveTrendColor(rows.map((row) => ({ value: row.tradersAfter })), "var(--page-accent-2)");
  const periodButtonLabel = PERIOD_OPTIONS.find((item) => item.id === period)?.label ?? period;
  const lastUpdatedLabel = data
    ? new Date(data.meta.updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const spark = useMemo(() => {
    if (!data) return { launches: [], migrated: [], volume: [], traders: [], wallets: [] };
    return {
      launches: data.launched.trend.map((point) => ({ value: point.value })),
      migrated: data.migrated.trend.map((point) => ({ value: point.value })),
      volume: data.volume.trend.map((point) => ({ value: point.value })),
      traders: data.traders.trend.map((point) => ({ value: point.value })),
      wallets: data.newWallets.trend.map((point) => ({ value: point.value })),
    };
  }, [data]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[linear-gradient(180deg,var(--theme-bg-soft),var(--theme-bg))] px-4 py-5 md:px-6 md:py-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,var(--page-glow,var(--theme-primary-soft)),transparent_20%),radial-gradient(circle_at_82%_14%,var(--page-glow-2,var(--theme-cool-glow)),transparent_22%),radial-gradient(circle_at_50%_96%,var(--theme-ambient-glow),transparent_26%),linear-gradient(180deg,var(--theme-bg-soft)_0%,var(--theme-bg)_44%,var(--theme-bg)_100%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(circle_at_center,var(--page-glow,var(--theme-primary-soft)),transparent_55%)] blur-3xl" />
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4">
        <section className="surface-panel-hero relative z-10 overflow-hidden rounded-[18px]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,var(--page-glow,var(--theme-primary-soft)),transparent_28%),radial-gradient(circle_at_82%_16%,var(--page-glow-2,var(--theme-cool-glow)),transparent_26%),linear-gradient(135deg,rgba(255,255,255,0.05),transparent_40%)]" />
          <div className="pointer-events-none absolute -right-24 top-[-70px] h-60 w-60 rounded-full bg-[color-mix(in_srgb,var(--theme-primary)_12%,transparent)] blur-3xl" />
          <div className="pointer-events-none absolute left-[-80px] top-16 h-56 w-56 rounded-full bg-[color-mix(in_srgb,var(--theme-secondary)_10%,transparent)] blur-3xl" />
          <div className="relative grid gap-4 border-b border-white/8 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:px-6 lg:py-5">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary-border bg-primary-soft px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.26em] text-content">
                <TrendingUp className="h-3.5 w-3.5" />
                Market intelligence
              </div>
              <div className="mt-4 flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] border border-primary-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] text-content shadow-[0_0_24px_color-mix(in_srgb,var(--theme-primary)_18%,transparent)]">
                  <ArrowLeft className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[28px] font-black tracking-tight text-white sm:text-[36px]">Обзор рынка</div>
                  <div className="mt-2 max-w-2xl text-[12px] leading-relaxed text-white/58 sm:text-[13px]">
                    Сводка запуска токенов, миграций и объема с быстрым переключением горизонта анализа и актуальной подсветкой источника.
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {data && (
                  <>
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-content-muted">
                      Source
                      <span className="text-content">{sourceLabel(data.meta.source)}</span>
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-full border border-primary-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-content-muted">
                      Updated {lastUpdatedLabel}
                    </span>
                  </>
                )}
                <span className="inline-flex items-center gap-2 rounded-full border border-primary-border bg-primary-soft px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-content">
                  <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--theme-primary)] shadow-[0_0_10px_var(--theme-primary-glow)]" />
                  {periodButtonLabel} window
                </span>
              </div>
            </div>
            <div className="w-full lg:w-[392px]">
              <PeriodTabs active={period} onChange={setPeriod} />
            </div>
          </div>
        </section>

        {loading && (
          <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-[98px] animate-pulse rounded-[10px] border border-white/10 bg-white/6" />
            ))}
          </section>
        )}

        {error && !loading && (
          <section className="rounded-[10px] border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </section>
        )}

        {data && !loading && (
          <>
            <section key={`${viewKey}-metrics`} className="surface-panel relative z-10 overflow-hidden rounded-[18px] p-3">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--page-glow,var(--theme-primary-soft)),transparent_36%),radial-gradient(circle_at_bottom_right,var(--page-glow-2,var(--theme-cool-glow)),transparent_36%)]" />
              <div className="relative grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <MetricCard label="Запущено" value={formatNumber(data.launched.total)} data={spark.launches} color="var(--page-accent)" warm />
              <MetricCard label="Мигрировало" value={formatNumber(data.migrated.total)} sub={`${data.migrated.share.toFixed(1)}% доля миграций`} data={spark.migrated} color="var(--page-accent-2)" />
              <MetricCard label="Объём" value={`${formatNumber(data.volume.totalSol)} SOL`} sub={`До мигр.: ${formatNumber(data.volume.beforeMigration)}`} sub2={`После мигр.: ${formatNumber(data.volume.afterMigration)}`} data={spark.volume} color="var(--page-accent-2)" />
              <MetricCard label="Трейдеры" value={formatNumber(data.traders.total)} sub={`До мигр.: ${formatNumber(data.traders.beforeMigration)}`} sub2={`После мигр.: ${formatNumber(data.traders.afterMigration)}`} data={spark.traders} color="var(--page-accent-2)" />
              <MetricCard
                label="Доля новых кошельков"
                value={`${data.traders.total > 0 ? ((data.newWallets.total / data.traders.total) * 100).toFixed(1) : "0.0"}%`}
                sub="new wallets / traders"
                data={spark.wallets}
                color="var(--page-accent-2)"
              />
              <MetricCard label="Активные токены" value={formatNumber(data.activeTokens.total)} sub="уникальные mint'ы в окне" data={data.activeTokens.trend.map((point) => ({ value: point.value }))} color="var(--page-accent)" warm />
              </div>
            </section>

            <section key={`${viewKey}-charts`} className="relative z-10 grid grid-cols-1 gap-3 xl:grid-cols-2">
              <GraphCard title="Запуски токенов" tone="amber" accentColor={launchTrendColor}>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="24%">
                      <defs>
                        <linearGradient id="launchBarsGlow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={launchTrendColor} stopOpacity={0.42} />
                          <stop offset="100%" stopColor={launchTrendColor} stopOpacity={0.03} />
                        </linearGradient>
                        <linearGradient id="launchBars" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={launchTrendColor} />
                          <stop offset="100%" stopColor="var(--theme-bg-border)" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.045)" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} tickFormatter={formatAxis} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "color-mix(in_srgb,var(--theme-success)_8%,transparent)" }} />
                      <Bar dataKey="launches" name="launched" fill="url(#launchBarsGlow)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={14} opacity={0.18} />
                      <Bar dataKey="launches" name="launched" fill="url(#launchBars)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={8} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </GraphCard>

              <GraphCard title="Миграции токенов">
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="24%">
                      <defs>
                        <linearGradient id="migrationBarsGlow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={migratedTrendColor} stopOpacity={0.34} />
                          <stop offset="100%" stopColor={migratedTrendColor} stopOpacity={0.03} />
                        </linearGradient>
                        <linearGradient id="migrationBars" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={migratedTrendColor} />
                          <stop offset="100%" stopColor="var(--theme-bg-border)" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.045)" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} tickFormatter={formatAxis} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "color-mix(in_srgb,var(--theme-success)_8%,transparent)" }} />
                      <Bar dataKey="migrated" name="migrated" fill="url(#migrationBarsGlow)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={14} opacity={0.18} />
                      <Bar dataKey="migrated" name="migrated" fill="url(#migrationBars)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={8} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </GraphCard>

              <GraphCard title="Объём (SOL)">
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="22%">
                      <defs>
                        <linearGradient id="volumeBeforeBars" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--theme-danger)" />
                          <stop offset="100%" stopColor="var(--theme-bg-border)" />
                        </linearGradient>
                        <linearGradient id="volumeAfterBars" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--theme-success)" />
                          <stop offset="100%" stopColor="var(--theme-bg-border)" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.045)" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} tickFormatter={formatAxis} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "color-mix(in_srgb,var(--theme-success)_8%,transparent)" }} />
                      <Bar dataKey="volumeBefore" name="before" stackId="volume" fill="url(#volumeBeforeBars)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={10} />
                      <Bar dataKey="volumeAfter" name="after" stackId="volume" fill="url(#volumeAfterBars)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={10} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </GraphCard>

                            <GraphCard title="?????????? ????????" accentColor={tradersTrendColor}>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="24%">
                      <defs>
                        <linearGradient id="tradersBeforeBarsGlow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--theme-danger)" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="var(--theme-danger)" stopOpacity={0.03} />
                        </linearGradient>
                        <linearGradient id="tradersAfterBarsGlow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--theme-success)" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="var(--theme-success)" stopOpacity={0.03} />
                        </linearGradient>
                        <linearGradient id="tradersBeforeBars" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--theme-danger)" />
                          <stop offset="100%" stopColor="var(--theme-bg-border)" />
                        </linearGradient>
                        <linearGradient id="tradersAfterBars" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--theme-success)" />
                          <stop offset="100%" stopColor="var(--theme-bg-border)" />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.045)" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "#c2c8d6", fontSize: 10 }} tickFormatter={formatAxis} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "color-mix(in_srgb,var(--theme-success)_8%,transparent)" }} />
                      <Bar dataKey="tradersBefore" name="before" fill="url(#tradersBeforeBarsGlow)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={12} opacity={0.18} />
                      <Bar dataKey="tradersAfter" name="after" fill="url(#tradersAfterBarsGlow)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={12} opacity={0.18} />
                      <Bar dataKey="tradersBefore" name="before" fill="url(#tradersBeforeBars)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={7} />
                      <Bar dataKey="tradersAfter" name="after" fill="url(#tradersAfterBars)" shape={(props: any) => <FinanceCandleShape {...props} />} barSize={7} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </GraphCard>
            </section>

            <section key={`${viewKey}-twitter`} className="surface-panel relative z-10 space-y-3 overflow-hidden rounded-[18px] p-3">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--page-glow,var(--theme-primary-soft)),transparent_34%),radial-gradient(circle_at_top_right,var(--page-glow-2,var(--theme-cool-glow)),transparent_34%)]" />
              <div className="relative space-y-3">
              <SectionTitle
                title="X аналитика"
                subtitle="Сообщества, аккаунты, контракты и недавние находки"
                action={
                  <div className="flex items-center gap-2 rounded-[8px] border border-white/10 bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-2 py-1 text-[10px] text-content-muted">
                    <MessageSquareText className="h-3.5 w-3.5 text-white/60" />
                    последние 365 дней
                  </div>
                }
              />
              <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <TwitterStatCard
                  label="Создано за 365d"
                  value={formatNumber(data.twitterSocial.created365d, 0)}
                  sub={`${formatNumber(data.twitterSocial.created30d, 0)} за 30d / ${formatNumber(data.twitterSocial.created7d, 0)} за 7d`}
                  icon={<Twitter className="h-4 w-4" />}
                />
                <TwitterStatCard
                  label="Обнаружено сегодня"
                  value={formatNumber(data.twitterSocial.discoveredToday, 0)}
                  sub={`${formatNumber(data.twitterSocial.discovered7d, 0)} за 7d / ${formatNumber(data.twitterSocial.discoveryVelocity7d, 0)} в день`}
                  icon={<Plug className="h-4 w-4" />}
                />
                <TwitterStatCard
                  label="С контрактом в шапке"
                  value={formatNumber(data.twitterSocial.accountsWithContracts, 0)}
                  sub={`${formatNumber(data.twitterSocial.totalAccounts, 0)} total accounts tracked`}
                  icon={<Users className="h-4 w-4" />}
                />
                <TwitterStatCard
                  label="Упоминания мемкоинов"
                  value={formatNumber(data.twitterSocial.memecoinAccounts, 0)}
                  sub={`${formatNumber(data.twitterSocial.pumpfunMentions, 0)} mentions of pump.fun / PumpFun`}
                  icon={<Bell className="h-4 w-4" />}
                />
              </section>
              <section className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <TwitterListCard
                  title="Топ контрактов"
                  subtitle="Адреса, которые чаще всего встречались в найденных профилях"
                  items={data.twitterSocial.topContracts.slice(0, 5).map((item) => ({
                    label: item.contractAddress.slice(0, 6),
                    value: item.contractAddress,
                    meta: `${formatNumber(item.accounts, 0)} acc / ${formatNumber(item.mentions, 0)} msg`,
                  }))}
                />
                <TwitterListCard
                  title="Недавние находки"
                  subtitle="Последние аккаунты и сообщества с контрактами в шапке"
                  items={data.twitterSocial.recentDiscoveries.slice(0, 5).map((item) => ({
                    label: item.subjectType === "community" ? "community" : "account",
                    value: item.handle ?? item.displayName ?? item.contractAddress ?? "unknown",
                    meta: item.createdAt ? new Date(item.createdAt).toLocaleDateString("ru-RU") : new Date(item.discoveredAt).toLocaleDateString("ru-RU"),
                  }))}
                />
              </section>
              </div>
            </section>

            <section className="surface-panel relative z-10 space-y-3 overflow-hidden rounded-[18px] p-3">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--page-glow,var(--theme-primary-soft)),transparent_34%),radial-gradient(circle_at_top_right,var(--page-glow-2,var(--theme-cool-glow)),transparent_34%)]" />
              <div className="relative space-y-3">
              <SectionTitle
                title="X / Twitter pulse"
                subtitle="Готовая аналитика из уже существующего `x-analysis` кода"
                action={
                  <div className="flex items-center gap-2 rounded-[8px] border border-white/10 bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-2 py-1 text-[10px] text-content-muted">
                    <Twitter className="h-3.5 w-3.5 text-white/60" />
                    {xTrendsLoading ? "loading" : xTrendsError ? "fallback" : "live"}
                  </div>
                }
              />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                <TwitterListCard
                  title="Hot keywords"
                  subtitle="What X is talking about right now"
                  items={displayedHotKeywords.map((item) => ({
                    label: item.keyword,
                    value: formatNumber(item.count, 0),
                    meta: item.categories.join(" / "),
                  }))}
                />
                <TwitterListCard
                  title="Hot tickers"
                  subtitle="Most repeated tickers in the current X feed"
                  items={displayedHotTickers.map((item) => ({
                    label: `$${item.ticker}`,
                    value: formatNumber(item.count, 0),
                    meta: item.categories.join(" / "),
                  }))}
                />
                <TwitterPulseCard trends={xTrends} />
              </div>
              {xTrendsError && (
                <div className="rounded-[8px] border border-primary-border bg-primary-soft px-3 py-2 text-[11px] text-content">
                  Twitter analysis could not be loaded, so the section is using the existing fallback state from market data.
                </div>
              )}
              </div>
            </section>


          </>
        )}
      </div>
    </main>
  );
}
