"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Twitter,
  Wallet,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { siteDesign } from "@/lib/siteDesign";
import type { KolListResponse, KolProfile, KolWallet } from "@/lib/kols/types";

interface KolsTwitterPanelProps {
  initialQuery?: string;
  detailMode?: boolean;
}

type PnlValue = { value: number; currency: "USD" | "SOL" } | null;

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}

function normalizeHandle(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    ?.toLowerCase() ?? "";
}

function solPnlFor(wallet: KolWallet, timeframe: 1 | 7 | 30) {
  if (timeframe === 30) return wallet.metrics.pnl30dSol;
  if (timeframe === 7) return wallet.metrics.pnl7dSol;
  return wallet.metrics.pnl1dSol;
}

function usdPnlFor(wallet: KolWallet, timeframe: 1 | 7 | 30) {
  if (timeframe === 30) return wallet.metrics.realizedPnl30dUsd;
  if (timeframe === 7) return wallet.metrics.realizedPnl7dUsd;
  return wallet.metrics.realizedPnl1dUsd;
}

function pnlFor(wallet: KolWallet, timeframe: 1 | 7 | 30): PnlValue {
  const usd = usdPnlFor(wallet, timeframe);
  if (typeof usd === "number" && Number.isFinite(usd)) return { value: usd, currency: "USD" };
  const sol = solPnlFor(wallet, timeframe);
  if (typeof sol === "number" && Number.isFinite(sol)) return { value: sol, currency: "SOL" };
  return null;
}

function aggregatePnl(profile: KolProfile, timeframe: 1 | 7 | 30): PnlValue {
  const usdValues = profile.wallets
    .map((wallet) => usdPnlFor(wallet, timeframe))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usdValues.length) {
    return { value: usdValues.reduce((sum, value) => sum + value, 0), currency: "USD" };
  }

  const solValues = profile.wallets
    .map((wallet) => solPnlFor(wallet, timeframe))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return solValues.length
    ? { value: solValues.reduce((sum, value) => sum + value, 0), currency: "SOL" }
    : null;
}

function walletWinLoss(wallet: KolWallet, timeframe: 1 | 7 | 30) {
  if (timeframe === 30) {
    return {
      wins: wallet.metrics.wins30d ?? wallet.metrics.wins,
      losses: wallet.metrics.losses30d ?? wallet.metrics.losses,
      rate: wallet.metrics.winRate30d ?? wallet.metrics.winRate,
    };
  }
  if (timeframe === 7) {
    return {
      wins: wallet.metrics.wins7d ?? wallet.metrics.wins,
      losses: wallet.metrics.losses7d ?? wallet.metrics.losses,
      rate: wallet.metrics.winRate7d ?? wallet.metrics.winRate,
    };
  }
  return {
    wins: wallet.metrics.wins1d ?? wallet.metrics.wins,
    losses: wallet.metrics.losses1d ?? wallet.metrics.losses,
    rate: wallet.metrics.winRate1d ?? wallet.metrics.winRate,
  };
}

function aggregateWinRate(profile: KolProfile, timeframe: 1 | 7 | 30) {
  let wins = 0;
  let losses = 0;
  for (const wallet of profile.wallets) {
    const row = walletWinLoss(wallet, timeframe);
    wins += row.wins ?? 0;
    losses += row.losses ?? 0;
  }
  const total = wins + losses;
  return total > 0 ? { rate: (wins / total) * 100, wins, losses } : null;
}

function confidenceTone(confidence: number) {
  if (confidence >= 90) return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (confidence >= 70) return "border-amber-400/30 bg-amber-400/10 text-amber-300";
  return "border-white/10 bg-white/5 text-content-muted";
}

function formatPnl(pnl: PnlValue) {
  if (!pnl) return "—";
  const sign = pnl.value > 0 ? "+" : "";
  if (pnl.currency === "USD") {
    const absolute = Math.abs(pnl.value);
    const formatted = absolute >= 1_000_000
      ? `${(absolute / 1_000_000).toFixed(2)}m`
      : absolute >= 1_000
        ? `${(absolute / 1_000).toFixed(1)}k`
        : absolute.toFixed(0);
    return `${pnl.value < 0 ? "-" : sign}$${formatted}`;
  }
  return `${sign}${pnl.value.toFixed(Math.abs(pnl.value) >= 10 ? 1 : 3)} SOL`;
}

export default function KolsTwitterPanel({ initialQuery = "", detailMode = false }: KolsTwitterPanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [timeframe, setTimeframe] = useState<1 | 7 | 30>(7);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [minConfidence, setMinConfidence] = useState(detailMode ? 0 : 60);
  const [data, setData] = useState<KolListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextQuery: string) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      query: nextQuery.trim(),
      timeframe: String(timeframe),
      limit: detailMode ? "20" : "100",
      verifiedOnly: verifiedOnly ? "1" : "0",
      minConfidence: String(minConfidence),
    });

    try {
      const response = await fetch(`/api/kols?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as KolListResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить KOL данные");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [detailMode, minConfidence, timeframe, verifiedOnly]);

  useEffect(() => {
    void load(submittedQuery);
  }, [load, submittedQuery]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  const summary = useMemo(() => {
    const items = data?.items ?? [];
    const wallets = items.reduce((sum, item) => sum + item.wallets.length, 0);
    const verified = items.reduce(
      (sum, item) => sum + item.wallets.filter((wallet) => wallet.verified).length,
      0,
    );
    const avgConfidence = items.length
      ? Math.round(items.reduce((sum, item) => sum + item.confidence, 0) / items.length)
      : 0;
    return { wallets, verified, avgConfidence };
  }, [data]);

  const exactDetail = useMemo(() => {
    if (!detailMode) return null;
    const expected = normalizeHandle(submittedQuery || initialQuery);
    return data?.items.find((item) => item.handle.toLowerCase() === expected) ?? null;
  }, [data, detailMode, initialQuery, submittedQuery]);

  return (
    <div className={siteDesign.page.compactContainerClassName} data-tag="trade.kols_twitter">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Twitter className="h-5 w-5 text-[color:var(--theme-secondary)]" />
            <h1 className="text-xl font-semibold text-content">
              {detailMode && exactDetail ? `@${exactDetail.handle}` : "KOLs Twitter"}
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-content-muted">
            X → публично связанные wallets → evidence → confidence. Curated labels не считаются доказательством владения;
            signed/connected identity источники отображаются отдельно.
          </p>
        </div>
        {detailMode ? (
          <Link href="/trade/kols-twitter" className={siteDesign.controls.actionButtonClassName}>
            Все KOLs
          </Link>
        ) : null}
      </header>

      <form onSubmit={submit} className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="grid gap-3 xl:grid-cols-[1.5fr_.35fr_.35fr_.45fr_auto]">
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">
              X handle / wallet
            </span>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
                placeholder="@handle или Solana/EVM address"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">PnL</span>
            <select
              value={timeframe}
              onChange={(event) => setTimeframe(Number(event.target.value) as 1 | 7 | 30)}
              className={siteDesign.controls.inputClassName}
            >
              <option value={1}>1D</option>
              <option value={7}>7D</option>
              <option value={30}>30D</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">Confidence</span>
            <select
              value={minConfidence}
              onChange={(event) => setMinConfidence(Number(event.target.value))}
              className={siteDesign.controls.inputClassName}
            >
              <option value={0}>All</option>
              <option value={60}>60+</option>
              <option value={70}>70+</option>
              <option value={90}>90+</option>
            </select>
          </label>

          <label className="flex items-end">
            <span className="flex h-[42px] w-full items-center gap-2 rounded-xl border border-bg-border bg-bg-elevated px-3 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={verifiedOnly}
                onChange={(event) => setVerifiedOnly(event.target.checked)}
                className="h-4 w-4 accent-[color:var(--theme-primary)]"
              />
              <ShieldCheck className="h-4 w-4" /> Verified only
            </span>
          </label>

          <div className="flex items-end gap-2">
            <button type="submit" className={siteDesign.controls.primaryActionClassName} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Найти
            </button>
            <button
              type="button"
              onClick={() => void load(submittedQuery)}
              className={siteDesign.controls.iconButtonClassName}
              aria-label="Refresh"
              title="Обновить"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </form>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {!detailMode ? (
        <section className="grid gap-3 sm:grid-cols-3">
          <StatCard label="KOL profiles" value={String(data?.total ?? 0)} sub="public X identities" />
          <StatCard label="Wallets shown" value={String(summary.wallets)} sub={`${summary.verified} verified`} />
          <StatCard label="Avg confidence" value={summary.avgConfidence ? `${summary.avgConfidence}/100` : "—"} sub="across visible profiles" />
        </section>
      ) : null}

      {data?.sourceStatus?.length ? (
        <section className="flex flex-wrap gap-2" aria-label="KOL data source health">
          {data.sourceStatus.map((source) => (
            <span
              key={source.source}
              title={source.detail}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                source.ok
                  ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                  : "border-amber-400/20 bg-amber-400/10 text-amber-300"
              }`}
            >
              {source.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              {source.source}
            </span>
          ))}
        </section>
      ) : null}

      {loading && !data ? (
        <div className="flex min-h-64 items-center justify-center rounded-2xl border border-bg-border surface-panel">
          <div className="flex items-center gap-2 text-sm text-content-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Загружаю KOL identities…
          </div>
        </div>
      ) : detailMode ? (
        exactDetail ? (
          <KolDetail profile={exactDetail} timeframe={timeframe} />
        ) : (
          <EmptyState query={submittedQuery} />
        )
      ) : data?.items?.length ? (
        <KolTable items={data.items} timeframe={timeframe} />
      ) : (
        <EmptyState query={submittedQuery} />
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="surface-panel rounded-xl border border-bg-border p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-content">{value}</div>
      <div className="mt-1 text-[11px] text-content-muted">{sub}</div>
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-bg-border surface-panel text-center">
      <Wallet className="mb-3 h-7 w-7 text-content-faint" />
      <div className="text-sm font-semibold text-content">Ничего не найдено</div>
      <p className="mt-1 max-w-lg text-xs text-content-muted">
        {query
          ? `Для “${query}” нет публично атрибутированных wallets в подключённых источниках.`
          : "Попробуй X handle или wallet address."}
      </p>
    </div>
  );
}

function KolTable({ items, timeframe }: { items: KolProfile[]; timeframe: 1 | 7 | 30 }) {
  return (
    <section className={siteDesign.table.shellClassName}>
      <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full text-left text-xs">
          <thead className={siteDesign.table.headerClassName}>
            <tr>
              <th className="px-4 py-3">KOL</th>
              <th className="px-4 py-3">Wallets</th>
              <th className="px-4 py-3">Confidence</th>
              <th className="px-4 py-3">PnL {timeframe}D</th>
              <th className="px-4 py-3">Winrate</th>
              <th className="px-4 py-3">Sources</th>
              <th className="px-4 py-3 text-right"><Filter className="ml-auto h-4 w-4" /></th>
            </tr>
          </thead>
          <tbody>
            {items.map((profile) => {
              const pnl = aggregatePnl(profile, timeframe);
              const win = aggregateWinRate(profile, timeframe);
              return (
                <tr key={profile.handle.toLowerCase()} className={siteDesign.table.rowClassName}>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-bg-border bg-bg-elevated text-sm font-bold text-content-muted">
                        {profile.avatar ? <img src={profile.avatar} alt="" className="h-full w-full object-cover" /> : profile.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <Link href={`/trade/kols-twitter/${encodeURIComponent(profile.handle)}`} className="font-semibold text-content hover:text-primary">
                          {profile.name}
                        </Link>
                        <a href={profile.twitterUrl} target="_blank" rel="noreferrer" className="mt-0.5 flex items-center gap-1 text-[10px] text-content-muted hover:text-content">
                          @{profile.handle} <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="space-y-1">
                      {profile.wallets.slice(0, 3).map((wallet) => (
                        <div key={`${wallet.chain}:${wallet.address}`} className="flex items-center gap-1.5 font-mono text-[10px] text-content-muted">
                          <span className="rounded border border-bg-border px-1 py-0.5 uppercase text-[8px]">{wallet.chain === "solana" ? "SOL" : "EVM"}</span>
                          {shortAddress(wallet.address)}
                          {wallet.verified ? <ShieldCheck className="h-3 w-3 text-emerald-300" /> : null}
                        </div>
                      ))}
                      {profile.wallets.length > 3 ? <div className="text-[9px] text-content-faint">+{profile.wallets.length - 3} more</div> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-flex rounded-full border px-2 py-1 font-semibold ${confidenceTone(profile.confidence)}`}>
                      {profile.confidence}/100
                    </span>
                  </td>
                  <td className={`px-4 py-3 align-top font-mono font-semibold ${pnl && pnl.value > 0 ? "text-emerald-300" : pnl && pnl.value < 0 ? "text-danger" : "text-content-muted"}`}>
                    {formatPnl(pnl)}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {win ? <><div className="font-semibold text-content">{win.rate.toFixed(1)}%</div><div className="text-[9px] text-content-faint">{win.wins}W / {win.losses}L</div></> : "—"}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {profile.sources.map((source) => <span key={source} className="rounded-full border border-bg-border bg-bg-elevated px-2 py-0.5 text-[9px] text-content-muted">{source}</span>)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right align-top">
                    <Link href={`/trade/kols-twitter/${encodeURIComponent(profile.handle)}`} className={siteDesign.controls.iconButtonClassName} aria-label={`Open ${profile.handle}`}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function KolDetail({ profile, timeframe }: { profile: KolProfile; timeframe: 1 | 7 | 30 }) {
  const pnl = aggregatePnl(profile, timeframe);
  const win = aggregateWinRate(profile, timeframe);
  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-4">
        <StatCard label="Confidence" value={`${profile.confidence}/100`} sub={profile.verified ? "verified evidence present" : "curated / inferred attribution"} />
        <StatCard label="Wallets" value={String(profile.wallets.length)} sub={`${profile.wallets.filter((wallet) => wallet.verified).length} verified`} />
        <StatCard label={`PnL ${timeframe}D`} value={formatPnl(pnl)} sub={pnl?.currency === "USD" ? "internal wallet_trades realized PnL" : "public leaderboard metric"} />
        <StatCard label="Winrate" value={win ? `${win.rate.toFixed(1)}%` : "—"} sub={win ? `${win.wins}W / ${win.losses}L` : "no trade metric"} />
      </section>

      <section className="space-y-3">
        {profile.wallets.map((wallet) => (
          <article key={`${wallet.chain}:${wallet.address}`} className="surface-panel rounded-2xl border border-bg-border p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-bg-border bg-bg-elevated px-2 py-1 text-[9px] font-semibold uppercase text-content-muted">{wallet.chain}</span>
                  {wallet.verified ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[9px] font-semibold text-emerald-300"><ShieldCheck className="h-3 w-3" /> verified</span> : null}
                  <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold ${confidenceTone(wallet.confidence)}`}>{wallet.confidence}/100</span>
                </div>
                <div className="mt-2 break-all font-mono text-xs text-content">{wallet.address}</div>
              </div>
              <div className="text-right text-xs text-content-muted">{formatPnl(pnlFor(wallet, timeframe))}</div>
            </div>

            <div className="mt-4 grid gap-2">
              {wallet.evidence.map((evidence, index) => (
                <div key={`${evidence.source}:${evidence.kind}:${index}`} className="rounded-xl border border-bg-border bg-bg-elevated/50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {evidence.verified ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}
                      <span className="text-xs font-semibold text-content">{evidence.source}</span>
                      <span className="rounded border border-bg-border px-1.5 py-0.5 text-[8px] uppercase text-content-faint">{evidence.kind.replaceAll("_", " ")}</span>
                    </div>
                    <span className="text-[10px] font-semibold text-content-muted">evidence {evidence.confidence}/100</span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-5 text-content-muted">{evidence.detail}</p>
                  {evidence.url ? <a href={evidence.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline">source <ExternalLink className="h-2.5 w-2.5" /></a> : null}
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
