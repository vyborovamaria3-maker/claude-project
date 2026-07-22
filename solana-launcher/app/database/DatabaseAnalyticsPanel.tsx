"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, ExternalLink, RefreshCcw, ShieldAlert, Sparkles, Target, Wallet } from "lucide-react";
import type {
  DatabaseAnalyticsFilters,
  DatabaseAnalytics,
  WalletProfile,
} from "@/lib/database-analytics";
import type { DatabaseDashboardData } from "./dashboardData";

type AnalyticsData = DatabaseDashboardData["analytics"];

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  return `${sign}${value.toFixed(2)}`;
}

function formatDate(value: number | null | undefined): string {
  if (!value) return "—";
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(timestamp).toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function panelClass(extra = "") {
  return `surface-panel p-4 ${extra}`;
}

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="surface-panel-hero p-3">
      <div className="text-[11px] uppercase tracking-wide text-white/35">{label}</div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
      <div className="mt-1 text-xs text-white/45">{detail}</div>
    </div>
  );
}

function SectionTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
      <div>
        <div className="flex items-center gap-2 text-white">
          <span className="text-sky-300">{icon}</span>
          <h2 className="text-lg font-bold">{title}</h2>
        </div>
        <p className="mt-1 text-xs text-white/45 max-w-3xl">{subtitle}</p>
      </div>
    </div>
  );
}

function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="surface-table max-h-[480px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 text-white/40">
          <tr>
            {headers.map((header, index) => (
              <th key={`${header}-${index}`} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <tr className="border-t border-bg-border/70">{children}</tr>;
}

function Cell({
  children,
  right = false,
  className = "",
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 whitespace-nowrap ${right ? "text-right" : "text-left"} ${className}`}>
      {children}
    </td>
  );
}

function scoreWallet(profile: WalletProfile, filters: DatabaseAnalyticsFilters) {
  let score = 0;
  if ((profile.avgRoi ?? -Infinity) >= filters.smartWalletMinRoi) score += 2;
  if ((profile.avgPnl ?? -Infinity) >= filters.smartWalletMinPnl) score += 2;
  if ((profile.avgWr ?? -Infinity) >= filters.smartWalletMinWr) score += 2;
  if ((profile.avgMigratedTokens ?? -Infinity) >= filters.smartWalletMinMigratedTokens) score += 1;
  if ((profile.avgMigratedPct ?? -Infinity) >= filters.smartWalletMinMigratedPct) score += 1;
  if ((profile.avgFastTrades ?? -Infinity) >= filters.smartWalletMinFastTrades) score += 1;
  if ((profile.avgFastTradesPct ?? -Infinity) >= filters.smartWalletMinFastTradesPct) score += 1;
  if ((profile.avgTokenWinRate ?? -Infinity) >= 0.55) score += 1;
  if ((profile.reports ?? 0) >= filters.smartWalletMinReports) score += 1;
  if ((profile.totalPnlSol ?? -Infinity) > 0) score += 1;
  return score;
}

function groupByCreator<T extends { creator: string }>(tokens: T[]) {
  const byCreator = new Map<string, T[]>();
  for (const token of tokens) {
    const list = byCreator.get(token.creator) ?? [];
    list.push(token);
    byCreator.set(token.creator, list);
  }
  return byCreator;
}

function computeDevRows(
  analytics: AnalyticsData,
  filters: DatabaseAnalyticsFilters,
  smartWallets: Set<string>,
  walletLookup: Map<string, WalletProfile>,
) {
  const byCreator = groupByCreator(analytics.tokenProfiles);
  const rows = Array.from(byCreator.entries()).map(([creator, tokens]) => {
    const launchTimes = tokens
      .map((token) => token.createdAt)
      .filter((value): value is number => Boolean(value))
      .sort((a, b) => a - b);
    const launchHours = tokens
      .map((token) => token.createdAt)
      .filter((value): value is number => Boolean(value))
      .map((value) => new Date((value < 10_000_000_000 ? value * 1000 : value)).getUTCHours());

    const walletCounts = new Map<string, number>();
    const tokenSmartCounts = tokens.map((token) => {
      let smartCount = 0;
      let smartRoiSum = 0;
      for (const buyer of token.buyerEdges) {
        if (!smartWallets.has(buyer.wallet)) continue;
        smartCount += 1;
        smartRoiSum += walletLookup.get(buyer.wallet)?.avgRoi ?? 0;
      }
      for (const buyer of token.buyerEdges) {
        walletCounts.set(buyer.wallet, (walletCounts.get(buyer.wallet) ?? 0) + 1);
      }
      return {
        smartCount,
        smartRoiAvg: smartCount > 0 ? smartRoiSum / smartCount : null,
      };
    });

    const repeatedWallets = Array.from(walletCounts.values()).filter((count) => count >= filters.insiderRepeatWalletThreshold).length;
    const smartCounts = tokenSmartCounts.map((item) => item.smartCount);
    const smartRoiValues = tokenSmartCounts.map((item) => item.smartRoiAvg).filter((value): value is number => value !== null);
    const successTokens = tokens.filter((token, index) => {
      const smartCount = smartCounts[index] ?? 0;
      const smartRoi = tokenSmartCounts[index]?.smartRoiAvg ?? 0;
      return (
        (!filters.successRequireMigration || token.isMigrated) &&
        (token.athUsd ?? 0) >= filters.successMinAthUsd &&
        (token.tokenVolumeSol ?? 0) >= filters.successMinVolumeSol &&
        smartCount >= filters.successMinSmartWallets &&
        smartRoi >= filters.successMinSmartWalletRoi
      );
    });

    const cadence = launchTimes.length > 1
      ? launchTimes.slice(1).reduce((sum, value, index) => sum + (value - launchTimes[index]), 0) / (launchTimes.length - 1) / 3600
      : null;
    const hourHistogram = new Map<number, number>();
    for (const hour of launchHours) hourHistogram.set(hour, (hourHistogram.get(hour) ?? 0) + 1);
    let bestLaunchHour: number | null = null;
    let bestLaunchCount = 0;
    for (const [hour, count] of hourHistogram.entries()) {
      if (count > bestLaunchCount) {
        bestLaunchCount = count;
        bestLaunchHour = hour;
      }
    }

    return {
      creator,
      tokens: tokens.length,
      migratedTokens: tokens.filter((token) => token.isMigrated).length,
      migrationRate: tokens.length > 0 ? tokens.filter((token) => token.isMigrated).length / tokens.length : 0,
      avgAthUsd: tokens.length > 0 ? tokens.reduce((sum, token) => sum + (token.athUsd ?? 0), 0) / tokens.length : null,
      maxAthUsd: tokens.length > 0 ? Math.max(...tokens.map((token) => token.athUsd ?? 0)) : null,
      avgVolumeSol: tokens.length > 0 ? tokens.reduce((sum, token) => sum + (token.tokenVolumeSol ?? 0), 0) / tokens.length : null,
      avgUniqueBuyers: tokens.length > 0 ? tokens.reduce((sum, token) => sum + token.uniqueBuyers, 0) / tokens.length : null,
      avgSmartWalletBuyers: tokens.length > 0 ? smartCounts.reduce((sum, count) => sum + count, 0) / tokens.length : null,
      smartWalletBuyersTotal: smartCounts.reduce((sum, count) => sum + count, 0),
      repeatedWallets,
      launchCadenceHours: cadence,
      bestLaunchHour,
      twitterTokens: tokens.filter((token) => Boolean(token.twitter)).length,
      successTokens: successTokens.length,
      successRate: tokens.length > 0 ? successTokens.length / tokens.length : 0,
      firstCreatedAt: launchTimes[0] ?? null,
      lastCreatedAt: launchTimes[launchTimes.length - 1] ?? null,
      avgSmartRoi: smartRoiValues.length > 0 ? smartRoiValues.reduce((sum, value) => sum + value, 0) / smartRoiValues.length : null,
    };
  });

  return rows.sort((a, b) =>
    b.successRate - a.successRate ||
    b.migratedTokens - a.migratedTokens ||
    (b.avgAthUsd ?? 0) - (a.avgAthUsd ?? 0)
  );
}

function computeWalletRows(analytics: AnalyticsData, filters: DatabaseAnalyticsFilters) {
  return analytics.walletProfiles
    .map((wallet) => {
      const score = scoreWallet(wallet, filters);
      return { ...wallet, score };
    })
    .sort((a, b) => b.score - a.score || (b.totalPnlSol ?? 0) - (a.totalPnlSol ?? 0));
}

function computeTokenRows(
  analytics: AnalyticsData,
  filters: DatabaseAnalyticsFilters,
  smartWallets: Set<string>,
  walletLookup: Map<string, WalletProfile>,
) {
  return analytics.tokenProfiles
    .map((token) => {
      const smartBuyerCount = token.buyerEdges.filter((buyer) => smartWallets.has(buyer.wallet)).length;
      const smartBuyerRoiValues = token.buyerEdges
        .filter((buyer) => smartWallets.has(buyer.wallet))
        .map((buyer) => walletLookup.get(buyer.wallet)?.avgRoi ?? 0);
      const smartBuyerRoi = smartBuyerRoiValues.length > 0
        ? smartBuyerRoiValues.reduce((sum, value) => sum + value, 0) / smartBuyerRoiValues.length
        : null;
      const repeatedBuyerCount = token.buyerEdges.filter((buyer) => buyer.buyTrades >= filters.insiderRepeatWalletThreshold).length;
      const earlyBuyerCount = token.buyerEdges.filter((buyer) => {
        if (!token.firstBuyAt || !buyer.firstBuyAt) return false;
        return buyer.firstBuyAt - token.firstBuyAt <= filters.insiderEarlyBuyMinutes * 60;
      }).length;
      const success =
        (!filters.successRequireMigration || token.isMigrated) &&
        (token.athUsd ?? 0) >= filters.successMinAthUsd &&
        (token.tokenVolumeSol ?? 0) >= filters.successMinVolumeSol &&
        smartBuyerCount >= filters.successMinSmartWallets &&
        (smartBuyerRoi ?? 0) >= filters.successMinSmartWalletRoi;

      return {
        ...token,
        smartBuyerCount,
        smartBuyerRoi,
        repeatedBuyerCount,
        earlyBuyerCount,
        success,
      };
    })
    .sort((a, b) =>
      Number(b.success) - Number(a.success) ||
      b.smartBuyerCount - a.smartBuyerCount ||
      (b.athUsd ?? 0) - (a.athUsd ?? 0)
    );
}

function computeCabalRows(tokens: ReturnType<typeof computeTokenRows>, filters: DatabaseAnalyticsFilters) {
  const rows: Array<{
    creator: string;
    wallet: string;
    tokensHit: number;
    earlyHits: number;
    bundleHits: number;
    avgEntryDelaySec: number | null;
    smartHits: number;
    score: number;
  }> = [];

  const byCreator = groupByCreator(tokens);
  for (const [creator, creatorTokens] of byCreator.entries()) {
    const walletMap = new Map<string, { tokensHit: number; earlyHits: number; bundleHits: number; delaySum: number; delayCount: number; smartHits: number }>();
    for (const token of creatorTokens) {
      for (const buyer of token.buyerEdges) {
        const row = walletMap.get(buyer.wallet) ?? { tokensHit: 0, earlyHits: 0, bundleHits: 0, delaySum: 0, delayCount: 0, smartHits: 0 };
        row.tokensHit += 1;
        row.delayCount += token.firstBuyAt && buyer.firstBuyAt ? 1 : 0;
        row.delaySum += token.firstBuyAt && buyer.firstBuyAt ? Math.max(0, buyer.firstBuyAt - token.firstBuyAt) : 0;
        if (token.firstBuyAt && buyer.firstBuyAt && buyer.firstBuyAt - token.firstBuyAt <= filters.insiderEarlyBuyMinutes * 60) {
          row.earlyHits += 1;
        }
        if (token.bundleCount > 0) row.bundleHits += 1;
        if (token.smartBuyerCount > 0) row.smartHits += 1;
        walletMap.set(buyer.wallet, row);
      }
    }

    for (const [wallet, item] of walletMap.entries()) {
      const score = item.tokensHit * 2 + item.earlyHits * 2 + item.bundleHits + item.smartHits;
      rows.push({
        creator,
        wallet,
        tokensHit: item.tokensHit,
        earlyHits: item.earlyHits,
        bundleHits: item.bundleHits,
        avgEntryDelaySec: item.delayCount > 0 ? item.delaySum / item.delayCount : null,
        smartHits: item.smartHits,
        score,
      });
    }
  }

  return rows
    .filter((row) => row.tokensHit >= filters.insiderRepeatWalletThreshold)
    .sort((a, b) => b.score - a.score || b.tokensHit - a.tokensHit)
    .slice(0, 250);
}

export function buildAnalyticsView(analytics: DatabaseAnalytics, filters: DatabaseAnalyticsFilters) {
  const walletLookup = new Map(analytics.walletProfiles.map((wallet) => [wallet.wallet, wallet] as const));
  const walletRows = computeWalletRows(analytics, filters);
  const smartWallets = new Set(walletRows.filter((wallet) => wallet.score >= filters.smartWalletMinScore).map((wallet) => wallet.wallet));
  const tokenRows = computeTokenRows(analytics, filters, smartWallets, walletLookup);
  const devRows = computeDevRows({ ...analytics, tokenProfiles: tokenRows }, filters, smartWallets, walletLookup);
  const cabalRows = computeCabalRows(tokenRows, filters);
  return { walletRows, smartWallets, tokenRows, devRows, cabalRows };
}

export function DatabaseAnalyticsPanel({ data }: { data: AnalyticsData }) {
  const [draftFilters, setDraftFilters] = useState<DatabaseAnalyticsFilters>(data.filters);
  const [filters, setFilters] = useState<DatabaseAnalyticsFilters>(data.filters);
  const view = useMemo(() => buildAnalyticsView(data, filters), [data, filters]);

  const summary = useMemo(() => {
    const totalAth = view.tokenRows.reduce((sum, token) => sum + (token.athUsd ?? 0), 0);
    const avgAth = view.tokenRows.length > 0 ? totalAth / view.tokenRows.length : 0;
    const successTokens = view.tokenRows.filter((token) => token.success).length;
    return {
      avgAth,
      successTokens,
      successRate: view.tokenRows.length > 0 ? successTokens / view.tokenRows.length : 0,
      avgSmartWallets: view.tokenRows.length > 0
        ? view.tokenRows.reduce((sum, token) => sum + token.smartBuyerCount, 0) / view.tokenRows.length
        : 0,
      avgMigrationRate: view.devRows.length > 0
        ? view.devRows.reduce((sum, dev) => sum + dev.migrationRate, 0) / view.devRows.length
        : 0,
    };
  }, [view.tokenRows, view.devRows]);

  const setNumber = (key: keyof DatabaseAnalyticsFilters, value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      setDraftFilters((current) => ({ ...current, [key]: parsed }));
    }
  };

  const applyFilters = () => setFilters(draftFilters);
  const resetFilters = () => {
    setDraftFilters(data.filters);
    setFilters(data.filters);
  };

  return (
    <section className="mt-6 space-y-6" data-tag="page.database.analytics">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Filtered tokens" value={view.tokenRows.length.toString()} detail={`${summary.successTokens} meet success rules`} />
        <StatCard label="Smart wallets" value={view.smartWallets.size.toString()} detail={`${view.walletRows.length} scored wallets`} />
        <StatCard label="Creators" value={view.devRows.length.toString()} detail={`${data.summary.creators} total creators in dataset`} />
        <StatCard label="Avg ATH" value={`$${formatCompact(summary.avgAth)}`} detail={`Migration rate ${formatNumber(summary.avgMigrationRate * 100)}%`} />
      </div>

      <div className={panelClass("space-y-4")}>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <SectionTitle
            icon={<Target className="h-4 w-4" />}
            title="Filter Studio"
            subtitle="Tighten or relax the thresholds and the tables below will recalculate instantly."
          />
          <button
            type="button"
            onClick={applyFilters}
            className="inline-flex items-center gap-2 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-400/15"
          >
            <Check className="h-3.5 w-3.5" />
            Apply filters
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-2 rounded-lg border border-bg-border/70 px-3 py-2 text-xs font-semibold text-white/80 hover:bg-white/5"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="surface-panel-hero space-y-3 p-3">
            <div className="text-sm font-semibold text-white">Smart wallet rules</div>
            {[
              ["smartWalletMinRoi", "Min ROI %"],
              ["smartWalletMinPnl", "Min PnL"],
              ["smartWalletMinWr", "Min winrate %"],
              ["smartWalletMinMigratedTokens", "Min migrated tokens"],
              ["smartWalletMinMigratedPct", "Min migrated %"],
              ["smartWalletMinFastTrades", "Min fast trades"],
              ["smartWalletMinFastTradesPct", "Min fast trades %"],
              ["smartWalletMinReports", "Min report count"],
              ["smartWalletMinScore", "Min score"],
            ].map(([key, label]) => (
              <label key={key} className="grid grid-cols-[1fr_96px] items-center gap-3 text-xs text-white/55">
                <span>{label}</span>
                  <input
                    type="number"
                  value={draftFilters[key as keyof DatabaseAnalyticsFilters] as number}
                  onChange={(e) => setNumber(key as keyof DatabaseAnalyticsFilters, e.target.value)}
                  className="h-9 rounded-lg border border-bg-border/70 bg-black/20 px-2 text-white outline-none focus:border-sky-400"
                />
              </label>
            ))}
          </div>

          <div className="surface-panel-hero space-y-3 p-3">
            <div className="text-sm font-semibold text-white">Success rules</div>
            {[
              ["successMinAthUsd", "Min ATH USD"],
              ["successMinVolumeSol", "Min volume SOL"],
              ["successMinSmartWallets", "Min smart wallets"],
              ["successMinSmartWalletRoi", "Min smart-wallet ROI %"],
            ].map(([key, label]) => (
              <label key={key} className="grid grid-cols-[1fr_96px] items-center gap-3 text-xs text-white/55">
                <span>{label}</span>
                  <input
                    type="number"
                  value={draftFilters[key as keyof DatabaseAnalyticsFilters] as number}
                  onChange={(e) => setNumber(key as keyof DatabaseAnalyticsFilters, e.target.value)}
                  className="h-9 rounded-lg border border-bg-border/70 bg-black/20 px-2 text-white outline-none focus:border-sky-400"
                />
              </label>
            ))}
            <label className="flex items-center gap-3 text-xs text-white/55">
              <input
                type="checkbox"
                checked={draftFilters.successRequireMigration}
                onChange={(e) => setDraftFilters((current) => ({ ...current, successRequireMigration: e.target.checked }))}
              />
              Require migration
            </label>
          </div>

          <div className="surface-panel-hero space-y-3 p-3">
            <div className="text-sm font-semibold text-white">Insider rules</div>
            {[
              ["insiderRepeatWalletThreshold", "Repeat wallet threshold"],
              ["insiderEarlyBuyMinutes", "Early buy window minutes"],
              ["insiderClusterWindowSec", "Buy cluster window sec"],
            ].map(([key, label]) => (
              <label key={key} className="grid grid-cols-[1fr_96px] items-center gap-3 text-xs text-white/55">
                <span>{label}</span>
                  <input
                    type="number"
                  value={draftFilters[key as keyof DatabaseAnalyticsFilters] as number}
                  onChange={(e) => setNumber(key as keyof DatabaseAnalyticsFilters, e.target.value)}
                  className="h-9 rounded-lg border border-bg-border/70 bg-black/20 px-2 text-white outline-none focus:border-sky-400"
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Sparkles className="h-4 w-4" />}
            title="Dev Metrics"
            subtitle="Creators grouped from the imported Excel data and enriched with on-chain trades."
          />
          <Table headers={["Creator", "Tokens", "Migrated", "ATH avg", "Smart buys", "Smart ROI", "Success", "Twitter", "Cadence h", "First launch"]}>
            {view.devRows.slice(0, 30).map((row) => (
              <Row key={row.creator}>
                <Cell className="font-mono text-xs">{row.creator.slice(0, 8)}…</Cell>
                <Cell right>{row.tokens}</Cell>
                <Cell right>{row.migratedTokens}</Cell>
                <Cell right>${formatCompact(row.avgAthUsd)}</Cell>
                <Cell right>{formatNumber(row.avgSmartWalletBuyers)}</Cell>
                <Cell right>{formatNumber(row.avgSmartRoi)}%</Cell>
                <Cell right>{formatNumber(row.successRate * 100)}%</Cell>
                <Cell right>{row.twitterTokens}</Cell>
                <Cell right>{formatNumber(row.launchCadenceHours)}</Cell>
                <Cell>{formatDate(row.firstCreatedAt)}</Cell>
              </Row>
            ))}
          </Table>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Wallet className="h-4 w-4" />}
            title="Smart Wallets"
            subtitle="Wallets that match the selected ROI / PnL / winrate / fast-trade rules."
          />
          <Table headers={["Wallet", "Score", "ROI", "PnL", "WR", "Reports", "Tokens", "Volume"]}>
            {view.walletRows.slice(0, 30).map((row) => (
              <Row key={row.wallet}>
                <Cell className="font-mono text-xs">{row.wallet.slice(0, 8)}…</Cell>
                <Cell right>{row.score}</Cell>
                <Cell right>{formatNumber(row.avgRoi)}%</Cell>
                <Cell right>{formatCompact(row.avgPnl)}</Cell>
                <Cell right>{formatNumber(row.avgWr)}%</Cell>
                <Cell right>{row.reports}</Cell>
                <Cell right>{formatNumber(row.tokensTraded)}</Cell>
                <Cell right>{formatCompact(row.totalVolumeSol)}</Cell>
              </Row>
            ))}
          </Table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<ShieldAlert className="h-4 w-4" />}
            title="Cabal / Insider Signals"
            subtitle="Wallets that repeat across the same dev and cluster into early buys."
          />
          <Table headers={["Creator", "Wallet", "Tokens", "Early", "Bundles", "Avg delay", "Score"]}>
            {view.cabalRows.slice(0, 30).map((row) => (
              <Row key={`${row.creator}-${row.wallet}`}>
                <Cell className="font-mono text-xs">{row.creator.slice(0, 8)}…</Cell>
                <Cell className="font-mono text-xs">{row.wallet.slice(0, 8)}…</Cell>
                <Cell right>{row.tokensHit}</Cell>
                <Cell right>{row.earlyHits}</Cell>
                <Cell right>{row.bundleHits}</Cell>
                <Cell right>{formatNumber(row.avgEntryDelaySec)}s</Cell>
                <Cell right>{row.score}</Cell>
              </Row>
            ))}
          </Table>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<ExternalLink className="h-4 w-4" />}
            title="X / Twitter"
            subtitle="The live scraper already exists in /x-analysis. This panel keeps the database view tied to the same social metadata."
          />
          <div className="surface-panel-hero space-y-3 p-4 text-sm text-white/70">
            <p>
              Tokens with stored Twitter metadata: <span className="text-white">{data.summary.twitterTokens}</span>
            </p>
            <p>
              For deeper post-history, views, and mention analysis, open the existing X analysis workspace.
            </p>
            <Link
              href="/x-analysis"
              className="inline-flex items-center gap-2 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-sm font-semibold text-sky-200 hover:bg-sky-400/15"
            >
              Open X analysis
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
