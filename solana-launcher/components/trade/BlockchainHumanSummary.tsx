"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, Database, Droplets, Link2, RefreshCw, Users, Wallet } from "lucide-react";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type ChainCheck = {
  id?: string;
  status?: "ok" | "warn" | "fail" | "unknown" | string;
  note?: string;
  source?: string;
};

type ChainFullPayload = {
  error?: string;
  cacheHit?: boolean;
  cacheSource?: string;
  cacheAgeMs?: number | null;
  latencyMs?: number | null;
  full?: {
    mint?: string;
    asOf?: number;
    checks?: ChainCheck[];
    liquidity?: {
      liquidityUsd?: number | null;
    };
    quality?: {
      concentration?: {
        totalHolderCount?: number | null;
        sampleCoveragePct?: number | null;
        holderSetComplete?: boolean;
        top10Pct?: number | null;
        adjustedTop10Pct?: number | null;
      };
      funding?: {
        available?: boolean;
        verifiedEdgeCount?: number | null;
        coveragePct?: number | null;
      };
      transactions?: {
        observedTrades?: number | null;
        observedSlots?: number | null;
      };
      walletProfiles?: unknown[];
    };
  };
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: number | null, digits = 1): string {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

function money(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function integer(value: number | null): string {
  return value == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function friendlyError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (/timeout|timed out|aborted/i.test(message)) {
    return "On-chain источник отвечает слишком долго. Полученные ранее данные не заменяются нулями.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "On-chain API не вернул ответ. Проверь соединение и повтори запрос.";
  }
  return message || "On-chain snapshot временно недоступен.";
}

function MetricCard({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card/70 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold text-content-faint">
        <span className="text-primary [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold text-content">{value}</div>
      {note ? <div className="mt-1 text-[9px] leading-4 text-content-faint">{note}</div> : null}
    </div>
  );
}

export default function BlockchainHumanSummary({ mint }: { mint: string }) {
  const [data, setData] = useState<ChainFullPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!MINT_RE.test(mint)) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeqRef.current;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/trade/chain-full", {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as ChainFullPayload;
      if (seq !== requestSeqRef.current) return;
      if (!response.ok || !payload.full) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      if (payload.full.mint && payload.full.mint !== mint) {
        throw new Error("stale chain snapshot ignored");
      }
      setData(payload);
    } catch (reason) {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setError(friendlyError(reason));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const full = data?.full;
  const quality = full?.quality;
  const concentration = quality?.concentration;
  const transactions = quality?.transactions;
  const funding = quality?.funding;

  const liquidity = finiteNumber(full?.liquidity?.liquidityUsd);
  const top10 = finiteNumber(concentration?.top10Pct);
  const adjustedTop10 = finiteNumber(concentration?.adjustedTop10Pct);
  const holderCount = finiteNumber(concentration?.totalHolderCount);
  const holderCoverage = finiteNumber(concentration?.sampleCoveragePct);
  const observedTrades = finiteNumber(transactions?.observedTrades);
  const observedSlots = finiteNumber(transactions?.observedSlots);
  const walletProfiles = Array.isArray(quality?.walletProfiles) ? quality!.walletProfiles!.length : null;
  const fundingEdges = funding?.available === true ? finiteNumber(funding.verifiedEdgeCount) : null;

  const tradeEvidenceAvailable = (observedTrades ?? 0) > 0 || (observedSlots ?? 0) > 0;
  const checks = Array.isArray(full?.checks) ? full!.checks! : [];
  const unknownChecks = checks.filter((row) => row.status === "unknown").length;
  const failedChecks = checks.filter((row) => row.status === "fail").length;
  const warningChecks = checks.filter((row) => row.status === "warn").length;

  const status = useMemo(() => {
    if (error) return "On-chain источник временно недоступен";
    if (loading && !data) return "Собираю основные on-chain данные…";
    if (!full) return "On-chain данные пока не получены";
    if (!tradeEvidenceAvailable || holderCoverage == null || holderCoverage < 50) return "On-chain данные частичные";
    return "Основные on-chain данные собраны";
  }, [data, error, full, holderCoverage, loading, tradeEvidenceAvailable]);

  if (!MINT_RE.test(mint)) return null;

  return (
    <section className="rounded-2xl border border-bg-border bg-bg-card/55 p-4" data-tag="blockchain.human-summary.v1-2-3-chain-direct">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-content">On-chain анализ</h2>
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold text-primary">Chain direct</span>
          </div>
          <p className="mt-1 max-w-3xl text-[10px] leading-5 text-content-faint">
            Основные blockchain-метрики загружаются напрямую из chain-full. DEV History и AI больше не блокируют эту сводку.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-elevated px-3 py-2 text-[10px] font-semibold text-content-muted transition hover:text-content disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Обновить
        </button>
      </div>

      <div className={`mt-4 rounded-xl border p-3 ${error ? "border-danger/30 bg-danger/5" : "border-bg-border bg-bg-elevated/25"}`}>
        <div className="text-xs font-semibold text-content">{status}</div>
        {error ? (
          <div className="mt-1 text-[10px] leading-5 text-danger/80">{error}</div>
        ) : (
          <div className="mt-1 text-[10px] leading-5 text-content-faint">
            {holderCoverage == null ? "Holder coverage неизвестен" : `Holder coverage: ${percent(holderCoverage, 0)}`}
            {` · risk checks: ${failedChecks} fail / ${warningChecks} warn / ${unknownChecks} unknown`}
            {concentration?.holderSetComplete === false ? " · holder set частичный" : ""}
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<Droplets />} label="Ликвидность" value={money(liquidity)} />
        <MetricCard icon={<Users />} label="Top-10 holders" value={percent(top10)} note={adjustedTop10 == null ? undefined : `С корректировками: ${percent(adjustedTop10)}`} />
        <MetricCard icon={<Users />} label="Holders" value={integer(holderCount)} note={holderCoverage == null ? "Покрытие выборки неизвестно" : `Покрытие top sample: ${percent(holderCoverage, 0)}`} />
        <MetricCard icon={<Database />} label="Наблюдаемые сделки" value={tradeEvidenceAvailable ? integer(observedTrades) : "Недоступно"} note={tradeEvidenceAvailable ? "Сделки в текущем chain snapshot" : "0 не трактуется как отсутствие торговли"} />
        <MetricCard icon={<Activity />} label="Наблюдаемые slots" value={tradeEvidenceAvailable ? integer(observedSlots) : "Недоступно"} />
        <MetricCard icon={<Wallet />} label="Профили кошельков" value={walletProfiles == null ? "—" : integer(walletProfiles)} />
        <MetricCard icon={<Link2 />} label="Funding links" value={funding?.available === true ? integer(fundingEdges) : "Недоступно"} note="Funding relation не доказывает общего владельца" />
        <MetricCard icon={<AlertTriangle />} label="Проверки риска" value={`${failedChecks} / ${warningChecks} / ${unknownChecks}`} note="fail / warn / unknown; unknown не означает safe" />
      </div>

      {!tradeEvidenceAvailable && full ? (
        <div className="mt-3 flex gap-3 rounded-xl border border-warning/25 bg-warning/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <div className="text-[11px] font-semibold text-content">История сделок в этом snapshot неполная</div>
            <div className="mt-1 text-[10px] leading-5 text-content-faint">
              Trade-dependent метрики остаются неизвестными. Нулевые счётчики не используются как доказательство отсутствия активности.
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] text-content-faint">
        <span>Chain latency: {data?.latencyMs == null ? "—" : `${data.latencyMs} ms`}</span>
        <span>Cache: {data?.cacheSource || (data?.cacheHit ? "cache" : "fresh")}</span>
        <span>DEV History и AI загружаются только после открытия соответствующих блоков ниже.</span>
      </div>
    </section>
  );
}
