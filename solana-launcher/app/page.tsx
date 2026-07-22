"use client";

import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Bot,
  Clock3,
  Gauge,
  LineChart,
  Package,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import ChartMetricSelector, { type ChartMetric } from "@/components/ChartMetricSelector";
import PeriodSelector, { type Period } from "@/components/PeriodSelector";
import PnLChart from "@/components/PnLChart";
import PnLTable from "@/components/PnLTable";
import { useOptionalI18n } from "@/components/providers/I18nProvider";
import { currentUser, getPeriodStats } from "@/lib/mockData";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

type Kpi = {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  tone: "green" | "purple" | "blue" | "amber";
};

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>("30D");
  const [metric, setMetric] = useState<ChartMetric>("pnl");
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? fallbackText;
  const isMobile = useIsMobileViewport();
  const periodStats = useMemo(() => getPeriodStats(period), [period]);

  const launchScore = Math.round(
    Math.min(99, periodStats.averageAthUsd / 2500 + periodStats.migrationRate * 35 + periodStats.successfulLaunches * 6)
  );
  const tradeScore = Math.round(
    Math.min(99, periodStats.winRate * 70 + Math.max(0, periodStats.pnl.sol) * 12 + periodStats.trades * 2)
  );
  const systemScore = Math.round(
    Math.min(99, 40 + periodStats.walletsUsed * 6 + Math.max(0, 20 - periodStats.feesPaid.sol * 18))
  );

  const launchKpis = useMemo<Kpi[]>(
    () => [
      {
        label: t("dashboard.launchAnalytics.myLaunches"),
        value: String(periodStats.tokensCreated),
        detail: t("dashboard.launchAnalytics.launchActivity", { period }),
        icon: Package,
        tone: "green",
      },
      {
        label: t("dashboard.launchAnalytics.averageAth"),
        value: "$" + periodStats.averageAthUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }),
        detail: t("dashboard.launchAnalytics.activeLaunches", {
          activeTokens: periodStats.activeTokens,
          successfulLaunches: periodStats.successfulLaunches,
        }),
        icon: Rocket,
        tone: "blue",
      },
      {
        label: t("dashboard.launchAnalytics.migrations"),
        value: String(periodStats.migrations),
        detail: t("dashboard.launchAnalytics.migrationRate", { rate: (periodStats.migrationRate * 100).toFixed(0) }),
        icon: ShieldCheck,
        tone: "purple",
      },
      {
        label: t("dashboard.launchAnalytics.launchFees"),
        value: periodStats.launchFeesSol.toFixed(3) + " SOL",
        detail: t("dashboard.launchAnalytics.onlyCreatedTokens"),
        icon: Zap,
        tone: "amber",
      },
    ],
    [period, periodStats, t]
  );

  const tradeKpis = useMemo<Kpi[]>(
    () => [
      {
        label: t("dashboard.tradeAnalytics.myTrades"),
        value: String(periodStats.trades),
        detail: t("dashboard.tradeAnalytics.executedTrades", { period }),
        icon: Activity,
        tone: "purple",
      },
      {
        label: t("dashboard.tradeAnalytics.tradePnl"),
        value: (periodStats.pnl.sol >= 0 ? "+" : "") + periodStats.pnl.sol.toFixed(3) + " SOL",
        detail: "$" + periodStats.pnl.usd.toFixed(0),
        icon: TrendingUp,
        tone: "green",
      },
      {
        label: t("dashboard.tradeAnalytics.tradeVolume"),
        value: periodStats.tradingVolume.sol.toFixed(2) + " SOL",
        detail: t("dashboard.tradeAnalytics.tradeFlow"),
        icon: LineChart,
        tone: "blue",
      },
      {
        label: t("dashboard.tradeAnalytics.winRate"),
        value: (periodStats.winRate * 100).toFixed(1) + "%",
        detail: t("dashboard.tradeAnalytics.avgHold", { minutes: periodStats.avgHoldMinutes.toFixed(0) }),
        icon: Gauge,
        tone: "amber",
      },
    ],
    [period, periodStats, t]
  );

  const launchInsights = isMobile
    ? [
        t("dashboard.mobileInsights.avgLaunchBudget", { value: periodStats.avgLaunchBudgetSol.toFixed(2) }),
        t("dashboard.mobileInsights.migrationCount", {
          count: periodStats.migrations,
          rate: (periodStats.migrationRate * 100).toFixed(0),
        }),
      ]
    : [
        t("dashboard.launchAnalytics.avgLaunchBudget", { value: periodStats.avgLaunchBudgetSol.toFixed(2) }),
        t("dashboard.launchAnalytics.migrationCount", {
          count: periodStats.migrations,
          rate: (periodStats.migrationRate * 100).toFixed(0),
        }),
        t("dashboard.launchAnalytics.bestToken", {
          token: periodStats.ath.token,
          mcap: periodStats.ath.mcap.toLocaleString(),
        }),
      ];

  const tradeInsights = isMobile
    ? [
        t("dashboard.mobileInsights.bestTrade", {
          value: (periodStats.bestTradePnlSol >= 0 ? "+" : "") + periodStats.bestTradePnlSol.toFixed(3),
        }),
        t("dashboard.mobileInsights.tradeFeesPaid", { value: periodStats.tradeFeesSol.toFixed(3) }),
      ]
    : [
        t("dashboard.tradeAnalytics.bestTrade", {
          value: (periodStats.bestTradePnlSol >= 0 ? "+" : "") + periodStats.bestTradePnlSol.toFixed(3),
        }),
        t("dashboard.tradeAnalytics.tradeFeesPaid", { value: periodStats.tradeFeesSol.toFixed(3) }),
        t("dashboard.tradeAnalytics.walletsUsed", { count: periodStats.walletsUsed }),
      ];

  if (isMobile) {
    return (
      <div data-tag="page.dashboard" className="w-full max-w-[1440px] mx-auto space-y-5 py-6">
        <HeroSection
          title={t("dashboard.title")}
          copy={t("dashboard.mobileCopy")}
          badge={t("dashboard.mobileSummary")}
          owner={t("dashboard.workspaceOwner", { username: currentUser.username, period })}
          launchScore={launchScore}
          tradeScore={tradeScore}
          systemScore={systemScore}
        />

        <SectionStack>
          <DashboardPanel
            title={t("dashboard.launchAnalytics.title")}
            subtitle={t("dashboard.launchAnalytics.subtitle")}
            icon={Rocket}
            accent="green"
            kpis={launchKpis}
            href="/token-launch"
            cta={t("dashboard.openLaunch")}
            insightsLabel={t("dashboard.insights")}
            insights={launchInsights}
          />
          <DashboardPanel
            title={t("dashboard.tradeAnalytics.title")}
            subtitle={t("dashboard.tradeAnalytics.subtitle")}
            icon={BarChart3}
            accent="purple"
            kpis={tradeKpis}
            href="/trade/analysis"
            cta={t("dashboard.openTrade")}
            insightsLabel={t("dashboard.insights")}
            insights={tradeInsights}
          />
        </SectionStack>

        <QuickLinks
          items={[
            { href: "/token-launch/new", label: t("dashboard.startNewBundle") },
            { href: "/trade/analysis", label: t("dashboard.analyzeToken") },
            { href: "/settings", label: t("dashboard.tuneWorkspace") },
          ]}
        />
      </div>
    );
  }

  return (
    <div data-tag="page.dashboard" className="w-full max-w-[1440px] mx-auto space-y-6 py-6">
      <HeroSection
        title={t("dashboard.title")}
        copy={t("dashboard.heroCopy")}
        badge={t("dashboard.operatorBadge")}
        owner={t("dashboard.workspaceOwner", { username: currentUser.username, period })}
        launchScore={launchScore}
        tradeScore={tradeScore}
        systemScore={systemScore}
      />

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <DashboardPanel
          title={t("dashboard.launchAnalytics.title")}
          subtitle={t("dashboard.launchAnalytics.subtitle")}
          icon={Rocket}
          accent="green"
          kpis={launchKpis}
          href="/token-launch"
          cta={t("dashboard.openLaunch")}
          insightsLabel={t("dashboard.insights")}
          insights={launchInsights}
        />
        <DashboardPanel
          title={t("dashboard.tradeAnalytics.title")}
          subtitle={t("dashboard.tradeAnalytics.subtitle")}
          icon={BarChart3}
          accent="purple"
          kpis={tradeKpis}
          href="/trade/analysis"
          cta={t("dashboard.openTrade")}
          insightsLabel={t("dashboard.insights")}
          insights={tradeInsights}
        />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[1.4fr_0.8fr] gap-5">
        <div className="glass rounded-2xl border border-bg-border p-5 md:p-6">
          <SectionHeader
            title={t("dashboard.performanceTimeline.title")}
            copy={t("dashboard.performanceTimeline.copy")}
            actions={
              <>
                <ChartMetricSelector active={metric} onChange={setMetric} />
                <PeriodSelector active={period} onChange={setPeriod} />
              </>
            }
          />
          <PnLChart metric={metric} period={period} />
        </div>

        <div className="glass rounded-2xl border border-bg-border p-5 md:p-6 space-y-4">
          <SectionHeader title={t("dashboard.workAnalysis.title")} copy={t("dashboard.workAnalysis.copy")} />
          <div className="space-y-3">
            <HealthRow
              label={t("dashboard.launchQuality")}
              value={periodStats.averageAthUsd > 0 ? "$" + periodStats.averageAthUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }) : t("dashboard.noLaunches")}
              pct={Math.min(100, periodStats.averageAthUsd / 2500)}
            />
            <HealthRow label={t("dashboard.walletUtilization")} value={`${periodStats.walletsUsed} wallets`} pct={Math.min(100, periodStats.walletsUsed * 12)} />
            <HealthRow label={t("dashboard.tradeThroughput")} value={`${periodStats.trades} trades`} pct={Math.min(100, periodStats.trades * 5)} />
            <HealthRow label={t("dashboard.feeEfficiency")} value={periodStats.feesPaid.sol.toFixed(3) + " SOL"} pct={Math.max(10, 100 - periodStats.feesPaid.sol * 40)} />
          </div>
        </div>
      </section>

      <PnLTable period={period} />

      <QuickLinks
        items={[
          { href: "/token-launch/new", label: t("dashboard.startNewBundle"), helper: t("dashboard.action.startBundle") },
          { href: "/trade/analysis", label: t("dashboard.analyzeToken"), helper: t("dashboard.action.analyzeToken") },
          { href: "/settings", label: t("dashboard.tuneWorkspace"), helper: t("dashboard.action.tuneWorkspace") },
        ]}
      />
    </div>
  );
}

function HeroSection({
  title,
  copy,
  badge,
  owner,
  launchScore,
  tradeScore,
  systemScore,
}: {
  title: string;
  copy: string;
  badge: string;
  owner: string;
  launchScore: number;
  tradeScore: number;
  systemScore: number;
}) {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(20,241,149,0.18),transparent_34%),radial-gradient(circle_at_top_right,rgba(153,69,255,0.18),transparent_32%),rgba(8,10,18,0.78)] p-6 md:p-8">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-neon-green/30 bg-neon-green/10 px-3 py-1 text-xs font-semibold text-neon-green">
            <Sparkles className="w-3.5 h-3.5" /> {badge}
          </div>
          <h1 className="mt-4 text-3xl md:text-5xl font-bold text-white tracking-tight">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm md:text-base text-white/55">{copy}</p>
          <p className="mt-2 text-xs text-white/35">{owner}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 min-w-[280px]">
          <MiniScore label="Launch" value={launchScore} />
          <MiniScore label="Trade" value={tradeScore} />
          <MiniScore label="System" value={systemScore} />
        </div>
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  copy,
  actions,
}: {
  title: string;
  copy: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
      <div>
        <h2 className="text-lg font-bold text-white">{title}</h2>
        <p className="text-xs text-white/45 mt-1">{copy}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function SectionStack({ children }: { children: ReactNode }) {
  return <section className="grid grid-cols-1 gap-5">{children}</section>;
}

function QuickLinks({
  items,
}: {
  items: Array<{ href: string; label: string; helper?: string }>;
}) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="group glass rounded-2xl border border-bg-border p-5 transition hover:border-neon-green/40 hover:shadow-neon-green"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-white">{item.label}</h3>
              {item.helper ? <p className="mt-1 text-sm text-white/45">{item.helper}</p> : null}
            </div>
            <ArrowUpRight className="w-4 h-4 text-white/25 group-hover:text-neon-green transition" />
          </div>
        </Link>
      ))}
    </section>
  );
}

function MiniScore({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
      <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-neon-green" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function DashboardPanel({
  title,
  subtitle,
  icon: Icon,
  accent,
  kpis,
  insights,
  href,
  cta,
  insightsLabel,
}: {
  title: string;
  subtitle: string;
  icon: typeof Rocket;
  accent: "green" | "purple";
  kpis: readonly Kpi[];
  insights: string[];
  href: string;
  cta: string;
  insightsLabel: string;
}) {
  const accentClass =
    accent === "green"
      ? "text-neon-green border-neon-green/30 bg-neon-green/10"
      : "text-neon-purple border-neon-purple/30 bg-neon-purple/10";

  return (
    <div className="glass rounded-2xl border border-bg-border p-5 md:p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`w-11 h-11 rounded-2xl border flex items-center justify-center ${accentClass}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">{title}</h2>
            <p className="text-xs text-white/45 mt-1">{subtitle}</p>
          </div>
        </div>
        <Link
          href={href}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition hover:bg-white/5 ${accentClass}`}
        >
          {cta}
          <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {kpis.map((kpi) => (
          <MetricCard key={kpi.label} {...kpi} />
        ))}
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/40 mb-3">
          <Clock3 className="w-3.5 h-3.5" />
          {insightsLabel}
        </div>
        <div className="space-y-2">
          {insights.map((item) => (
            <div key={item} className="flex items-start gap-2 text-sm text-white/65">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-neon-green shrink-0" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail, icon: Icon, tone }: Kpi) {
  const tones: Record<Kpi["tone"], string> = {
    green: "text-neon-green bg-neon-green/10 border-neon-green/20",
    purple: "text-neon-purple bg-neon-purple/10 border-neon-purple/20",
    blue: "text-neon-blue bg-neon-blue/10 border-neon-blue/20",
    amber: "text-amber-300 bg-amber-300/10 border-amber-300/20",
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
      <div className={`w-9 h-9 rounded-xl border flex items-center justify-center ${tones[tone]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="mt-3 text-[10px] uppercase tracking-widest text-white/35">{label}</div>
      <div className="mt-1 text-xl font-bold text-white">{value}</div>
      <div className="mt-1 text-xs text-white/40">{detail}</div>
    </div>
  );
}

function HealthRow({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-white/65">{label}</span>
        <span className="font-semibold text-white">{value}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,var(--theme-accent),#9945ff)]"
          style={{ width: `${Math.max(4, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function fallbackText(key: string, vars?: Record<string, string | number>) {
  const templates: Record<string, string> = {
    "dashboard.title": "Launch control center",
    "dashboard.mobileCopy": "A compact view of launches, trading and system health.",
    "dashboard.heroCopy": "A compact view of launches, trading and system health.",
    "dashboard.mobileSummary": "Mobile summary",
    "dashboard.operatorBadge": "Operator panel",
    "dashboard.workspaceOwner": "Workspace: {{username}} | period {{period}}",
    "dashboard.launchAnalytics.title": "Launch analytics",
    "dashboard.launchAnalytics.subtitle": "Token creation, migrations and launch performance",
    "dashboard.tradeAnalytics.title": "Trade analytics",
    "dashboard.tradeAnalytics.subtitle": "Volume, PnL and execution quality",
    "dashboard.performanceTimeline.title": "Performance timeline",
    "dashboard.performanceTimeline.copy": "Switch metric and period to inspect the curve.",
    "dashboard.workAnalysis.title": "Work analysis",
    "dashboard.workAnalysis.copy": "Operational health across launch and trading activity.",
    "dashboard.openLaunch": "Open launches",
    "dashboard.openTrade": "Open trades",
    "dashboard.insights": "Insights",
    "dashboard.startNewBundle": "Start new bundle",
    "dashboard.analyzeToken": "Analyze token",
    "dashboard.tuneWorkspace": "Tune workspace",
    "dashboard.action.startBundle": "Create a new launch flow.",
    "dashboard.action.analyzeToken": "Inspect token dynamics and quality.",
    "dashboard.action.tuneWorkspace": "Adjust workspace settings and defaults.",
    "dashboard.launchQuality": "Launch quality",
    "dashboard.walletUtilization": "Wallet utilization",
    "dashboard.tradeThroughput": "Trade throughput",
    "dashboard.feeEfficiency": "Fee efficiency",
    "dashboard.noLaunches": "No launches yet",
  };

  const template = templates[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));
}
