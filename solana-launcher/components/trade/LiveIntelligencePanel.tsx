"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  Clock3,
  Network,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  TrendingUp,
  Twitter,
  WalletCards,
  Zap,
} from "lucide-react";
import {
  DEFAULT_SOCIAL_OPTIONS,
  MINT_RE,
  clamp,
  deriveSocialMetrics,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "@/lib/trade/social-intelligence";
import {
  buildSocialSourceParams,
  fetchJson,
  readChainStream,
} from "@/lib/trade/social-intelligence-api";
import { buildAnalysisSnapshot } from "@/lib/trade/intelligence-agent";
import {
  buildLiveIntelligence,
  type LiveIntelligenceSignal,
  type PromoterRow,
  type SourceConclusion,
  type WalletActor,
} from "@/lib/trade/live-intelligence";
import { useTradeStream, type TradeItem } from "@/hooks/useTradeStream";
import type { PumpFunChartSignal } from "@/components/PumpFunChart";

const PumpFunChart = dynamic(() => import("@/components/PumpFunChart"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[680px] items-center justify-center rounded-2xl border border-bg-border bg-bg-card text-sm text-content-muted">
      Загружаю торговый график…
    </div>
  ),
});

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");
const FAST_REFRESH_MS = 15_000;
const CHAIN_REFRESH_MS = 30_000;
const AI_REFRESH_MS = 60_000;

const LIVE_OPTIONS = {
  ...DEFAULT_SOCIAL_OPTIONS,
  lookback: "24" as const,
  xLimit: 60,
  tgLimit: 250,
};

type LoadState = "idle" | "loading" | "ready" | "error";
type Snapshot = ReturnType<typeof buildAnalysisSnapshot>;

function compact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function ago(value: number | null) {
  if (value == null) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}с назад`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}м назад`;
  return `${Math.round(seconds / 3600)}ч назад`;
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

export default function LiveIntelligencePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMint = params.get("mint")?.trim() || "";
  const [query, setQuery] = useState(initialMint);
  const [mint, setMint] = useState(initialMint);
  const [x, setX] = useState<TwitterStats | null>(null);
  const [tg, setTg] = useState<SocialTimeline | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [chain, setChain] = useState<ChainAnalysis | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [ai, setAi] = useState<AiEnvelope | null>(null);
  const [state, setState] = useState<LoadState>(initialMint ? "loading" : "idle");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [liveSignals, setLiveSignals] = useState<LiveIntelligenceSignal[]>([]);
  const [liveImpact, setLiveImpact] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const fastBusyRef = useRef(false);
  const chainBusyRef = useRef(false);
  const aiBusyRef = useRef(false);
  const chainRef = useRef<ChainAnalysis | null>(null);
  const mintRef = useRef(initialMint);
  const snapshotRef = useRef<Snapshot | null>(null);
  const tgRef = useRef<SocialTimeline | null>(null);

  useEffect(() => {
    chainRef.current = chain;
  }, [chain]);
  useEffect(() => {
    mintRef.current = mint;
  }, [mint]);
  useEffect(() => {
    tgRef.current = tg;
  }, [tg]);

  const deterministic = useMemo(
    () => deriveSocialMetrics(x, tg, market, chain, null, channels, LIVE_OPTIONS),
    [x, tg, market, chain, channels],
  );
  const derived = useMemo(
    () => deriveSocialMetrics(x, tg, market, chain, ai, channels, LIVE_OPTIONS),
    [x, tg, market, chain, ai, channels],
  );
  const snapshot = useMemo(() => {
    if (!mint || (!x && !tg)) return null;
    return buildAnalysisSnapshot({
      mint,
      symbol: x?.symbol || null,
      tokenName: market?.pair?.name || null,
      derived: deterministic,
      x,
      tg,
      market,
      chain,
    });
  }, [mint, x, tg, market, chain, deterministic]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const featureCoverage = snapshot && snapshot.featureCount > 0
    ? (snapshot.featureCount - snapshot.missingFeatureCount) / snapshot.featureCount
    : null;
  const model = useMemo(
    () => buildLiveIntelligence({
      x,
      tg,
      market,
      chain,
      channels,
      derived,
      ai,
      featureCoverage,
      liveImpact,
    }),
    [x, tg, market, chain, channels, derived, ai, featureCoverage, liveImpact],
  );

  const chartSignals = useMemo<PumpFunChartSignal[]>(() => {
    const unique = new Map<string, LiveIntelligenceSignal>();
    for (const signal of [...model.signals, ...liveSignals]) unique.set(signal.id, signal);
    return [...unique.values()]
      .sort((left, right) => left.time - right.time)
      .slice(-10)
      .map((signal) => ({
        id: signal.id,
        time: signal.time,
        shortLabel: signal.shortLabel,
        impact: signal.impact,
        tone: signal.tone,
      }));
  }, [model.signals, liveSignals]);

  const refreshAi = useCallback(async (
    currentMint: string,
    suppliedSnapshot?: Snapshot | null,
    suppliedTg?: SocialTimeline | null,
  ) => {
    const currentSnapshot = suppliedSnapshot ?? snapshotRef.current;
    const currentTg = suppliedTg ?? tgRef.current;
    if (!currentSnapshot?.evidence.length || aiBusyRef.current) return;
    aiBusyRef.current = true;
    try {
      const value = await fetchJson<AiEnvelope>("/api/trade/social-ai", undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mint: currentMint,
          symbol: currentSnapshot.symbol || "",
          tokenName: currentSnapshot.tokenName || undefined,
          timeline: (currentTg?.timeline || []).filter((item) => !item.platform || item.platform.toLowerCase() === "telegram"),
          snapshot: currentSnapshot,
        }),
      });
      if (mintRef.current === currentMint) setAi(value);
    } catch (error) {
      if (mintRef.current !== currentMint) return;
      const message = error instanceof Error ? error.message : "AI недоступен";
      setWarnings((value) => [...value.filter((item) => !item.startsWith("Qwen:")), `Qwen: ${message}`]);
    } finally {
      aiBusyRef.current = false;
    }
  }, []);

  const load = useCallback(async (nextMint: string) => {
    const contract = nextMint.trim();
    if (!MINT_RE.test(contract)) {
      setWarnings(["Введи корректный Solana mint / CA."]);
      setState("error");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    mintRef.current = contract;
    snapshotRef.current = null;
    tgRef.current = null;
    chainRef.current = null;
    setState("loading");
    setWarnings([]);
    setMint(contract);
    setQuery(contract);
    setX(null);
    setTg(null);
    setMarket(null);
    setChain(null);
    setChannels([]);
    setLiveSignals([]);
    setLiveImpact(0);
    setAi(null);
    router.replace(`/trade/analysis/live-intelligence?mint=${encodeURIComponent(contract)}`, { scroll: false });

    const { x: xParams, tg: tgParams } = buildSocialSourceParams(contract, LIVE_OPTIONS);
    const chainPromise = readChainStream(contract, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted && mintRef.current === contract) {
        const message = error instanceof Error ? error.message : "недоступен";
        setWarnings((value) => [...value, `Blockchain: ${message}`]);
      }
      return null;
    });

    const results = await Promise.allSettled([
      fetchJson<TwitterStats>(`/api/trade/dev-twitter?${xParams}`, controller.signal),
      fetchJson<SocialTimeline>(`${BACKEND}/api/v1/social/token/${encodeURIComponent(contract)}?${tgParams}`, controller.signal),
      fetchJson<Market>(`/api/token-ohlcv?mint=${encodeURIComponent(contract)}`, controller.signal),
      fetchJson<{ items: Channel[] }>(`${BACKEND}/api/v1/telegram/channels?limit=100`, controller.signal),
    ]);
    if (controller.signal.aborted || mintRef.current !== contract) return;

    const nextX = results[0].status === "fulfilled" ? results[0].value : null;
    const nextTg = results[1].status === "fulfilled" ? results[1].value : null;
    const nextMarket = results[2].status === "fulfilled" ? results[2].value : null;
    const nextChannels = results[3].status === "fulfilled" && Array.isArray(results[3].value.items)
      ? results[3].value.items
      : [];
    const nextChain = await chainPromise;
    if (controller.signal.aborted || mintRef.current !== contract) return;

    setX(nextX);
    setTg(nextTg);
    setMarket(nextMarket);
    setChannels(nextChannels);
    setChain(nextChain);
    tgRef.current = nextTg;
    chainRef.current = nextChain;
    setLastUpdated(Date.now());

    const sourceWarnings = [
      nextX ? null : "X: данные недоступны",
      nextTg ? null : "Telegram: данные недоступны",
      nextMarket ? null : "Market: данные недоступны",
      nextChain ? null : "Blockchain: данные недоступны",
    ].filter((value): value is string => value != null);
    setWarnings((value) => [...new Set([...value, ...sourceWarnings])]);

    if (!nextX && !nextTg && !nextChain) {
      setState("error");
      return;
    }

    const nextDeterministic = deriveSocialMetrics(nextX, nextTg, nextMarket, nextChain, null, nextChannels, LIVE_OPTIONS);
    const nextSnapshot = buildAnalysisSnapshot({
      mint: contract,
      symbol: nextX?.symbol || null,
      tokenName: nextMarket?.pair?.name || null,
      derived: nextDeterministic,
      x: nextX,
      tg: nextTg,
      market: nextMarket,
      chain: nextChain,
    });
    snapshotRef.current = nextSnapshot;
    setState("ready");
    void refreshAi(contract, nextSnapshot, nextTg);
  }, [refreshAi, router]);

  const refreshFast = useCallback(async () => {
    if (!mint || fastBusyRef.current) return;
    const currentMint = mint;
    fastBusyRef.current = true;
    try {
      const { x: xParams, tg: tgParams } = buildSocialSourceParams(currentMint, LIVE_OPTIONS);
      const results = await Promise.allSettled([
        fetchJson<TwitterStats>(`/api/trade/dev-twitter?${xParams}`),
        fetchJson<SocialTimeline>(`${BACKEND}/api/v1/social/token/${encodeURIComponent(currentMint)}?${tgParams}`),
        fetchJson<Market>(`/api/token-ohlcv?mint=${encodeURIComponent(currentMint)}`),
      ]);
      if (mintRef.current !== currentMint) return;
      let changed = false;
      if (results[0].status === "fulfilled") { setX(results[0].value); changed = true; }
      if (results[1].status === "fulfilled") { setTg(results[1].value); tgRef.current = results[1].value; changed = true; }
      if (results[2].status === "fulfilled") { setMarket(results[2].value); changed = true; }
      if (changed) setLastUpdated(Date.now());
    } finally {
      fastBusyRef.current = false;
    }
  }, [mint]);

  const refreshChain = useCallback(async () => {
    if (!mint || chainBusyRef.current) return;
    const currentMint = mint;
    chainBusyRef.current = true;
    const controller = new AbortController();
    try {
      const value = await readChainStream(currentMint, controller.signal);
      if (value && mintRef.current === currentMint) {
        setChain(value);
        chainRef.current = value;
        setLiveSignals([]);
        setLiveImpact(0);
        setLastUpdated(Date.now());
      }
    } catch {
      // The fast live layer keeps the previous classified snapshot until the next successful refresh.
    } finally {
      chainBusyRef.current = false;
    }
  }, [mint]);

  const handleLiveTrade = useCallback((trade: TradeItem) => {
    const wallets = chainRef.current?.wallets || [];
    const known = wallets.find((wallet) => wallet.address === trade.signer);
    const smart = Boolean(known?.smartClassificationAvailable && known.isSmart === true);
    const whale = trade.solAmount >= 20;
    if (!smart && !whale) return;

    const baseImpact = smart ? 2.6 : 2.1;
    const impact = clamp((trade.isBuy ? 1 : -1) * (baseImpact + Math.min(1.8, trade.solAmount / 30)), -5, 5);
    const kind = smart ? "smart-wallet" : "whale";
    const title = smart
      ? `Smart-wallet ${trade.isBuy ? "купил" : "продал"} ${trade.solAmount.toFixed(1)} SOL`
      : `Whale ${trade.isBuy ? "купил" : "продал"} ${trade.solAmount.toFixed(1)} SOL`;
    const signal: LiveIntelligenceSignal = {
      id: `live-${trade.signature}`,
      time: trade.ts,
      source: "chain",
      category: kind,
      title,
      detail: `${shortAddress(trade.signer)} · реальная on-chain сделка`,
      impact,
      tone: impact >= 0 ? "positive" : "negative",
      shortLabel: `${smart ? "SMART" : "WHALE"} ${impact >= 0 ? "+" : ""}${impact.toFixed(1)}`,
    };
    setLiveSignals((value) => [...value.filter((item) => item.id !== signal.id), signal].slice(-8));
    setLiveImpact((value) => clamp(value + impact, -10, 10));
    setLastUpdated(Date.now());
  }, []);

  useTradeStream(mint, 1, handleLiveTrade, { headless: true });

  useEffect(() => {
    if (initialMint && MINT_RE.test(initialMint)) void load(initialMint);
    return () => abortRef.current?.abort();
    // The URL mint is loaded once; future changes go through the search form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mint || state !== "ready") return;
    const fastTimer = window.setInterval(() => void refreshFast(), FAST_REFRESH_MS);
    const chainTimer = window.setInterval(() => void refreshChain(), CHAIN_REFRESH_MS);
    const aiTimer = window.setInterval(() => void refreshAi(mint), AI_REFRESH_MS);
    return () => {
      window.clearInterval(fastTimer);
      window.clearInterval(chainTimer);
      window.clearInterval(aiTimer);
    };
  }, [mint, state, refreshFast, refreshChain, refreshAi]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load(query);
  };

  if (!mint && state === "idle") {
    return (
      <div className="space-y-4" data-tag="trade.live_intelligence.v1">
        <PageHeader query={query} setQuery={setQuery} submit={submit} loading={false} lastUpdated={null} />
        <div className="rounded-2xl border border-bg-border bg-bg-card p-12 text-center text-sm text-content-muted">
          Вставь mint токена, чтобы собрать X, Telegram, блокчейн, рынок и общий вывод в одной системе.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-tag="trade.live_intelligence.v1">
      <PageHeader query={query} setQuery={setQuery} submit={submit} loading={state === "loading"} lastUpdated={lastUpdated} />

      {warnings.length > 0 && (
        <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-content-muted">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span>{warnings.join(" · ")}</span>
        </div>
      )}

      {mint && (
        <section className="overflow-hidden rounded-2xl border border-bg-border bg-bg-card">
          <PumpFunChart
            mint={mint}
            symbol={x?.symbol || "TOKEN"}
            tokenName={market?.pair?.name || "Live Intelligence"}
            intelligenceSignals={chartSignals}
          />
        </section>
      )}

      <section className="grid gap-3 xl:grid-cols-[1.15fr_.85fr]">
        <DecisionCard model={model} />
        <FactorsCard model={model} signals={[...model.signals, ...liveSignals]} />
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <SourceCard icon={<Twitter />} title="X / Twitter" conclusion={model.x}>
          <PromoterTable rows={model.x.promoters} kind="x" />
        </SourceCard>
        <SourceCard icon={<Send />} title="Telegram" conclusion={model.telegram}>
          <PromoterTable rows={model.telegram.promoters} kind="telegram" />
        </SourceCard>
        <SourceCard icon={<WalletCards />} title="Blockchain" conclusion={model.chain}>
          <WalletTable rows={model.chain.actors} />
        </SourceCard>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <SourceCard icon={<Network />} title="Связь источников" conclusion={model.crossSource} />
        <SourceCard icon={<TrendingUp />} title="Рынок и момент входа" conclusion={model.market}>
          <div className="mt-3 rounded-xl border border-bg-border bg-bg-card p-3">
            <div className="text-[9px] uppercase tracking-wider text-content-faint">Сигнал входа сейчас</div>
            <div className="mt-1 flex items-end gap-2">
              <span className="font-mono text-3xl font-bold text-content">{Math.round(model.entryScore)}</span>
              <span className="pb-1 text-xs text-content-faint">/100</span>
            </div>
            <div className="mt-1 text-sm font-semibold text-content">{model.entryStatus}</div>
            <p className="mt-2 text-[10px] leading-4 text-content-muted">
              Это аналитическая оценка текущего момента по доступным данным, а не гарантия доходности и не персональная рекомендация.
            </p>
          </div>
        </SourceCard>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <TriggerCard title="Что подтвердит тезис" tone="positive" rows={model.confirmationTriggers} />
        <TriggerCard title="Что сломает тезис" tone="negative" rows={model.invalidationTriggers} />
      </section>

      <details className="overflow-hidden rounded-2xl border border-bg-border bg-bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-semibold text-content">
          <span>Техническая детализация · все рассчитанные параметры</span>
          <span className="flex items-center gap-2 text-[10px] text-content-faint">
            {snapshot ? `${snapshot.featureCount - snapshot.missingFeatureCount}/${snapshot.featureCount} заполнено` : "snapshot не готов"}
            <ChevronDown className="h-4 w-4" />
          </span>
        </summary>
        <div className="grid gap-3 border-t border-bg-border p-4 xl:grid-cols-2">
          {derived.groups.map((group) => (
            <div key={group.title} className="overflow-hidden rounded-xl border border-bg-border">
              <div className="border-b border-bg-border bg-bg-elevated px-3 py-2 text-[11px] font-semibold text-content">{group.title}</div>
              <div className="divide-y divide-bg-border">
                {group.rows.map((row) => (
                  <div key={row.label} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-[10px]">
                    <div>
                      <div className="text-content-muted">{row.label}</div>
                      {row.note && <div className="mt-0.5 text-[8px] text-content-faint">{row.note}</div>}
                    </div>
                    <div className="text-right font-mono font-semibold text-content">{row.value}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function PageHeader({
  query,
  setQuery,
  submit,
  loading,
  lastUpdated,
}: {
  query: string;
  setQuery: (value: string) => void;
  submit: (event: FormEvent) => void;
  loading: boolean;
  lastUpdated: number | null;
}) {
  return (
    <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-content">Живой интеллект по токену</h1>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-content-muted">
          Что происходит в X и Telegram, кто двигает внимание, кто покупает/продаёт в блокчейне и насколько качественный вход прямо сейчас.
        </p>
        <div className="mt-2 flex items-center gap-2 text-[9px] text-content-faint">
          <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_currentColor]" />
          <span>Fast refresh 15с · chain classification 30с · AI critic 60с</span>
          {lastUpdated && <><Clock3 className="ml-2 h-3 w-3" /><span>обновлено {ago(lastUpdated)}</span></>}
        </div>
      </div>
      <form onSubmit={submit} className="flex w-full gap-2 xl:w-auto">
        <div className="relative min-w-0 flex-1 xl:w-[430px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-lg border border-bg-border bg-bg-card py-2.5 pl-9 pr-3 font-mono text-xs text-content outline-none focus:border-primary/40"
            placeholder="Solana mint / CA"
          />
        </div>
        <button type="submit" disabled={loading} className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Анализ
        </button>
      </form>
    </header>
  );
}

function ScoreCell({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3">
      <div className="text-[8px] uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 font-mono text-xl font-bold text-content">{value}</div>
      <div className="mt-1 text-[9px] leading-4 text-content-faint">{helper}</div>
    </div>
  );
}

function DecisionCard({ model }: { model: ReturnType<typeof buildLiveIntelligence> }) {
  return (
    <article className="surface-panel rounded-2xl border border-bg-border p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-content-faint">Главный вывод</div>
          <h2 className="mt-2 max-w-3xl text-base font-semibold leading-6 text-content">{model.verdict}</h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-content-muted">{model.summary}</p>
        </div>
        <div className="shrink-0 rounded-xl border border-primary/25 bg-primary/5 p-3 text-right">
          <div className="text-[8px] uppercase tracking-wider text-content-faint">Вход сейчас</div>
          <div className="mt-1 font-mono text-3xl font-bold text-content">{Math.round(model.entryScore)}<span className="text-sm text-content-faint">/100</span></div>
          <div className="mt-1 text-xs font-semibold text-primary">{model.entryStatus}</div>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <ScoreCell label="Сила монеты" value={`${Math.round(model.tokenStrength)}/100`} helper="Качество структуры, не тайминг." />
        <ScoreCell label="Риск" value={`${Math.round(model.riskScore)}/100`} helper="Social + chain + перегрев." />
        <ScoreCell label="Уверенность" value={`${Math.round(model.confidence)}%`} helper="Покрытие и качество источников." />
        <ScoreCell label="Согласованность" value={`${Math.round(model.stability)}/100`} helper="Насколько X/TG/chain/market совпадают." />
      </div>
    </article>
  );
}

function FactorsCard({ model, signals }: { model: ReturnType<typeof buildLiveIntelligence>; signals: LiveIntelligenceSignal[] }) {
  const latest = [...signals].sort((a, b) => b.time - a.time).slice(0, 4);
  return (
    <article className="surface-panel rounded-2xl border border-bg-border p-4">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-content">Что меняет вывод сейчас</h2>
      </div>
      <div className="mt-3 space-y-2">
        {latest.length ? latest.map((signal) => (
          <div key={signal.id} className="grid grid-cols-[52px_1fr_auto] gap-2 rounded-xl border border-bg-border bg-bg-card p-2.5">
            <span className={`font-mono text-xs font-bold ${signal.impact >= 0 ? "text-success" : "text-danger"}`}>{signal.impact >= 0 ? "+" : ""}{signal.impact.toFixed(1)}</span>
            <div>
              <div className="text-[10px] font-semibold text-content">{signal.title}</div>
              <div className="mt-0.5 text-[9px] leading-4 text-content-faint">{signal.detail}</div>
            </div>
            <span className="text-[8px] text-content-faint">{ago(signal.time)}</span>
          </div>
        )) : <div className="text-xs text-content-faint">Значимых событий пока нет.</div>}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <FactorList title="Поддерживает" rows={model.positiveFactors} tone="positive" />
        <FactorList title="Мешает" rows={model.negativeFactors} tone="negative" />
      </div>
    </article>
  );
}

function FactorList({ title, rows, tone }: { title: string; rows: string[]; tone: "positive" | "negative" }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3">
      <div className={`text-[9px] font-semibold uppercase tracking-wider ${tone === "positive" ? "text-success" : "text-danger"}`}>{title}</div>
      <div className="mt-2 space-y-1.5">
        {(rows.length ? rows : ["Нет сильных факторов в этой группе."]).map((row) => (
          <div key={row} className="flex gap-2 text-[9px] leading-4 text-content-muted"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />{row}</div>
        ))}
      </div>
    </div>
  );
}

function SourceCard({ icon, title, conclusion, children }: { icon: ReactNode; title: string; conclusion: SourceConclusion; children?: ReactNode }) {
  return (
    <article className="surface-panel rounded-2xl border border-bg-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
          <div><h2 className="text-sm font-semibold text-content">{title}</h2><div className="mt-0.5 text-[9px] text-content-faint">{conclusion.state}</div></div>
        </div>
        <div className="font-mono text-lg font-bold text-content">{Math.round(conclusion.score)}<span className="text-[10px] text-content-faint">/100</span></div>
      </div>
      <p className="mt-3 min-h-12 text-[11px] leading-5 text-content-muted">{conclusion.summary}</p>
      <div className="mt-3 space-y-1.5">
        {conclusion.facts.map((fact) => <div key={fact} className="flex gap-2 text-[9px] leading-4 text-content-faint"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />{fact}</div>)}
      </div>
      {children}
    </article>
  );
}

function PromoterTable({ rows, kind }: { rows: PromoterRow[]; kind: "x" | "telegram" }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-bg-border">
      <div className="grid grid-cols-[1.25fr_.55fr_.55fr] gap-2 border-b border-bg-border bg-bg-elevated px-2.5 py-2 text-[8px] uppercase tracking-wider text-content-faint">
        <span>Кто двигает внимание</span><span>{kind === "x" ? "Охват" : "Рейтинг"}</span><span>Активность</span>
      </div>
      <div className="divide-y divide-bg-border">
        {(rows.length ? rows.slice(0, 5) : []).map((row) => (
          <div key={row.name} className="grid grid-cols-[1.25fr_.55fr_.55fr] gap-2 px-2.5 py-2 text-[9px]">
            <div className="min-w-0">
              <div className="truncate font-semibold text-content">{row.name}</div>
              <div className="mt-0.5 truncate text-[8px] text-content-faint">
                {row.assessment}
                {kind === "x" && row.verified ? " · verified" : ""}
                {kind === "telegram" && row.winRate != null ? ` · win ${row.winRate.toFixed(0)}%` : ""}
                {kind === "telegram" && row.rugRate != null ? ` · rug ${row.rugRate.toFixed(0)}%` : ""}
              </div>
            </div>
            <div className="font-mono text-content-muted">{kind === "x" ? compact(row.followers) : row.sourceScore == null ? "—" : Math.round(row.sourceScore)}</div>
            <div className="text-content-muted">{kind === "x" ? `${row.messages} пост. · ${compact(row.engagement)} eng` : `${row.messages} msg · ${row.explicitCalls} call`}</div>
          </div>
        ))}
        {!rows.length && <div className="px-3 py-4 text-[9px] text-content-faint">Нет достаточных данных по авторам/каналам.</div>}
      </div>
    </div>
  );
}

function WalletTable({ rows }: { rows: WalletActor[] }) {
  return (
    <details className="mt-4 overflow-hidden rounded-xl border border-bg-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-bg-elevated px-3 py-2 text-[9px] font-semibold text-content">
        <span>??? ??????? ??????</span>
        <span className="flex items-center gap-2 text-[8px] font-normal text-content-faint">
          {rows.length} ?????????
          <ChevronDown className="h-3.5 w-3.5" />
        </span>
      </summary>

      <div className="border-t border-bg-border">
        <div className="grid grid-cols-[1.2fr_.65fr_.55fr] gap-2 border-b border-bg-border bg-bg-elevated px-2.5 py-2 text-[8px] uppercase tracking-wider text-content-faint">
          <span>???????</span>
          <span>?????</span>
          <span>????????</span>
        </div>

        <div className="divide-y divide-bg-border">
          {rows.slice(0, 6).map((row) => (
            <div
              key={row.address}
              className="grid grid-cols-[1.2fr_.65fr_.55fr] gap-2 px-2.5 py-2 text-[9px]"
            >
              <div>
                <div className="font-mono font-semibold text-content">
                  {shortAddress(row.address)}
                </div>
                <div className="mt-0.5 text-[8px] text-content-faint">
                  {row.role} ? {row.buys} buy / {row.sells} sell
                </div>
              </div>

              <div className="font-mono text-content-muted">
                {row.volumeSol.toFixed(1)} SOL
              </div>

              <div
                className={
                  row.direction === "buying"
                    ? "text-success"
                    : row.direction === "selling"
                      ? "text-danger"
                      : "text-content-muted"
                }
              >
                {row.direction === "buying"
                  ? "????????"
                  : row.direction === "selling"
                    ? "???????"
                    : "????????"}
              </div>
            </div>
          ))}

          {!rows.length && (
            <div className="px-3 py-4 text-[9px] text-content-faint">
              ???????? ??? ?? ????????????????.
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function TriggerCard({ title, tone, rows }: { title: string; tone: "positive" | "negative"; rows: string[] }) {
  return (
    <article className="surface-panel rounded-2xl border border-bg-border p-4">
      <div className="flex items-center gap-2">
        {tone === "positive" ? <TrendingUp className="h-4 w-4 text-success" /> : <ShieldAlert className="h-4 w-4 text-danger" />}
        <h2 className="text-sm font-semibold text-content">{title}</h2>
      </div>
      <div className="mt-3 space-y-2">
        {rows.map((row) => <div key={row} className="flex gap-2 rounded-lg border border-bg-border bg-bg-card p-2.5 text-[10px] leading-4 text-content-muted"><span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone === "positive" ? "bg-success" : "bg-danger"}`} />{row}</div>)}
      </div>
    </article>
  );
}
