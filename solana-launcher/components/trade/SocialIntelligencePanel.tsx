"use client";

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
  ChevronUp,
  Clock3,
  Loader2,
  Radar,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Twitter,
  WalletCards,
} from "lucide-react";
import SocialAnalysisChart from "@/components/trade/SocialAnalysisChart";
import { siteDesign } from "@/lib/siteDesign";
import {
  DEFAULT_SOCIAL_OPTIONS,
  MINT_RE,
  clamp,
  deriveSocialMetrics,
  numberOr,
  score,
  signedPct,
  upsertWarning,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type Lookback,
  type Market,
  type Metric,
  type SocialOptions,
  type SocialTimeline,
  type TwitterStats,
} from "@/lib/trade/social-intelligence";
import {
  buildSocialSourceParams,
  fetchJson,
  readChainStream,
} from "@/lib/trade/social-intelligence-api";
import {
  buildAnalysisSnapshot,
  type AnalysisSnapshot,
} from "@/lib/trade/intelligence-agent";

type TelegramCollectorStatus = {
  mode?: string;
  configured?: boolean;
  mtproto_configured?: boolean;
  session_configured?: boolean;
  running?: boolean;
  background_running?: boolean;
  connected?: boolean;
  monitored_channels?: number;
  public_web_enabled?: boolean;
  public_web_configured?: boolean;
  public_web_channels?: number;
  last_scan_at?: string | null;
  last_scan_messages?: number;
  last_scan_matches?: number;
  last_error?: string | null;
};

type TwitterCollectionMeta = NonNullable<TwitterStats["meta"]> & {
  authenticatedBrowser?: boolean;
  coverageConfirmed?: boolean;
};

type SourceErrors = {
  x: string | null;
  tg: string | null;
  market: string | null;
  chain: string | null;
};

type SourceState = "loading" | "ready" | "degraded" | "error" | "idle";
type InsightTone = "positive" | "warning" | "danger" | "neutral";

const EMPTY_SOURCE_ERRORS: SourceErrors = { x: null, tg: null, market: null, chain: null };

function settledError(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === "fulfilled") return null;
  return result.reason instanceof Error ? result.reason.message : String(result.reason || "недоступен");
}

function telegramCollector(tg: SocialTimeline | null): TelegramCollectorStatus | null {
  const meta = tg?.meta as (SocialTimeline["meta"] & { telegramCollector?: TelegramCollectorStatus }) | undefined;
  return meta?.telegramCollector || null;
}

function twitterCollectionMeta(x: TwitterStats | null): TwitterCollectionMeta | null {
  return (x?.meta as TwitterCollectionMeta | undefined) || null;
}

function shortAddress(value: string | null | undefined, left = 5, right = 4): string {
  if (!value) return "—";
  if (value.length <= left + right + 2) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function formatAgo(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  const ms = parsed < 1e12 ? parsed * 1000 : parsed;
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return "сейчас";
  if (minutes < 60) return `${minutes}м назад`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}ч назад`;
  return `${Math.round(minutes / 1440)}д назад`;
}

function friendlySourceError(source: "Telegram" | "X" | "Market" | "Blockchain", message: string | null): string | null {
  if (!message) return null;
  const normalized = message.toLowerCase();
  if (source === "X" && (
    normalized.includes("x login required")
    || normalized.includes("authenticated x browser session")
    || normalized.includes("session expired")
    || normalized.includes("login required")
  )) {
    return "X: нужна авторизованная браузерная сессия. Запусти `npm run x:login` в solana-launcher.";
  }
  if (source === "Telegram" && (
    normalized.includes("tg_api_id")
    || normalized.includes("tg_api_hash")
    || normalized.includes("telegram session")
  )) {
    return "Telegram: MTProto не авторизован. Проверь TG_API_ID/TG_API_HASH и создай TG_SESSION_STRING.";
  }
  if (normalized.includes("could not validate credentials") || normalized.includes("401")) {
    return `${source}: backend-авторизация не пройдена. Войди в аккаунт на этом localhost.`;
  }
  if (normalized.includes("active subscription required") || normalized.includes("403")) {
    return `${source}: backend доступен, но текущему аккаунту не хватает entitlement/subscription.`;
  }
  if (normalized.includes("failed to fetch") || normalized.includes("networkerror")) {
    return `${source}: frontend не смог связаться с backend.`;
  }
  return `${source}: ${message}`;
}

function telegramCollectorLabel(collector: TelegramCollectorStatus | null): string {
  if (!collector) return "status недоступен";
  if (collector.connected) return `${collector.mode || "mtproto"} · connected`;
  if (collector.running) return `${collector.mode || "collector"} · running`;
  if (collector.mtproto_configured && !collector.session_configured) return "MTProto API настроен · session отсутствует";
  if (collector.configured) return `${collector.mode || "collector"} · configured`;
  if (collector.public_web_enabled) return "public web · без активного покрытия";
  return "не настроен";
}

function confidencePercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(clamp(value <= 1 ? value * 100 : value));
}

export default function SocialIntelligencePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMintRef = useRef(params.get("mint")?.trim() || "");
  const initialMint = initialMintRef.current;

  const [query, setQuery] = useState(initialMint);
  const [mint, setMint] = useState(initialMint);
  const [options, setOptions] = useState<SocialOptions>(DEFAULT_SOCIAL_OPTIONS);
  const [x, setX] = useState<TwitterStats | null>(null);
  const [tg, setTg] = useState<SocialTimeline | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [chain, setChain] = useState<ChainAnalysis | null>(null);
  const [ai, setAi] = useState<AiEnvelope | null>(null);
  const [snapshot, setSnapshot] = useState<AnalysisSnapshot | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sourceErrors, setSourceErrors] = useState<SourceErrors>(EMPTY_SOURCE_ERRORS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (next: string) => {
      const contract = next.trim();
      if (!MINT_RE.test(contract)) {
        setError("Введи корректный Solana mint / CA.");
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setMint(contract);
      setQuery(contract);
      setLoading(true);
      setChainLoading(true);
      setAiLoading(false);
      setError(null);
      setWarnings([]);
      setSourceErrors(EMPTY_SOURCE_ERRORS);
      setX(null);
      setTg(null);
      setMarket(null);
      setChain(null);
      setAi(null);
      setSnapshot(null);
      router.replace(`/trade/analysis/social?mint=${encodeURIComponent(contract)}`, { scroll: false });

      const { x: xParams, tg: tgParams } = buildSocialSourceParams(contract, options);
      let chainFailure: string | null = null;

      const chainPromise = readChainStream(contract, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setChain(value);
          return value;
        })
        .catch((chainError: unknown) => {
          if (controller.signal.aborted) return null;
          chainFailure = chainError instanceof Error ? chainError.message : "недоступна";
          return null;
        })
        .finally(() => {
          if (!controller.signal.aborted) setChainLoading(false);
        });

      const tgUrl = `/api/trade/social-source?kind=token&mint=${encodeURIComponent(contract)}&${tgParams.toString()}`;
      const channelsUrl = "/api/trade/social-source?kind=channels&limit=100";
      const [xResult, tgResult, marketResult, channelResult] = await Promise.allSettled([
        fetchJson<TwitterStats>(`/api/trade/dev-twitter?${xParams}`, controller.signal),
        fetchJson<SocialTimeline>(tgUrl, controller.signal),
        fetchJson<Market>(`/api/token-ohlcv?mint=${encodeURIComponent(contract)}`, controller.signal),
        fetchJson<{ items: Channel[] }>(channelsUrl, controller.signal),
      ]);
      if (controller.signal.aborted) return;

      const nextX = xResult.status === "fulfilled" ? xResult.value : null;
      const nextTg = tgResult.status === "fulfilled" ? tgResult.value : null;
      const nextMarket = marketResult.status === "fulfilled" ? marketResult.value : null;
      const nextChannels = channelResult.status === "fulfilled" && Array.isArray(channelResult.value.items)
        ? channelResult.value.items
        : [];

      setX(nextX);
      setTg(nextTg);
      setMarket(nextMarket);
      setChannels(nextChannels);
      setLoading(false);

      const xFailure = settledError(xResult);
      const tgFailure = settledError(tgResult);
      const marketFailure = settledError(marketResult);
      const reputationFailure = settledError(channelResult);
      if (reputationFailure) {
        setWarnings((value) => upsertWarning(value, `TG reputation: ${reputationFailure}`));
      }

      const nextChain = await chainPromise;
      if (controller.signal.aborted) return;

      setSourceErrors({ x: xFailure, tg: tgFailure, market: marketFailure, chain: chainFailure });

      if (!nextX && !nextTg && !nextMarket && !nextChain) {
        setError("Источники анализа не ответили. Проверь backend, авторизацию и локальные integration credentials.");
        return;
      }

      const deterministic = deriveSocialMetrics(
        nextX,
        nextTg,
        nextMarket,
        nextChain,
        null,
        nextChannels,
        options,
      );
      const nextSnapshot = buildAnalysisSnapshot({
        mint: contract,
        symbol: nextX?.symbol || options.symbol || null,
        tokenName: nextMarket?.pair?.name || null,
        derived: deterministic,
        x: nextX,
        tg: nextTg,
        market: nextMarket,
        chain: nextChain,
      });
      setSnapshot(nextSnapshot);

      if (!nextSnapshot.features.some((feature) => !feature.missing)) return;

      setAiLoading(true);
      void fetchJson<AiEnvelope>("/api/trade/social-ai", controller.signal, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mint: contract,
          symbol: nextX?.symbol || options.symbol,
          tokenName: nextMarket?.pair?.name,
          timeline: (nextTg?.timeline || []).filter(
            (item) => !item.platform || item.platform.toLowerCase() === "telegram",
          ),
          snapshot: nextSnapshot,
        }),
      })
        .then((value) => {
          if (!controller.signal.aborted) setAi(value);
        })
        .catch((aiError: unknown) => {
          if (controller.signal.aborted) return;
          const message = aiError instanceof Error ? aiError.message : "AI недоступен";
          setAi({ agent: "qwen", available: false, error: message });
          setWarnings((value) => upsertWarning(value, `Qwen: ${message}`));
        })
        .finally(() => {
          if (!controller.signal.aborted) setAiLoading(false);
        });
    },
    [options, router],
  );

  useEffect(() => {
    if (initialMint && MINT_RE.test(initialMint)) void run(initialMint);
    return () => abortRef.current?.abort();
    // Initial URL mint is intentionally analyzed only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const derived = useMemo(
    () => deriveSocialMetrics(x, tg, market, chain, ai, channels, options),
    [x, tg, market, chain, ai, channels, options],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(query);
  };

  const symbol = x?.symbol || options.symbol || null;
  const priceChange = market?.pair?.changeH1 ?? market?.pair?.change24h ?? null;
  const coreSourceCount = [x, tg, market, chain].filter(Boolean).length;
  const hasCoreData = coreSourceCount > 0;

  return (
    <div className="space-y-4" data-tag="trade.social_intelligence.v8">
      <section className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Radar className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold text-content">Token Intelligence</h1>
              {aiLoading ? (
                <span className="rounded-full border border-primary-border bg-primary-soft px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                  Qwen thinking
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-content-faint">
              <span>Price · Trades · Telegram · X · Blockchain · Qwen</span>
              {mint ? <span className="font-mono">{shortAddress(mint, 8, 7)}</span> : null}
              {market?.pair?.name ? <span className="text-content-muted">{market.pair.name}</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <CompactMetric label="SOCIAL" value={hasCoreData ? score(derived.socialScore) : "—"} />
            <CompactMetric label="X" value={x ? score(derived.xScore) : "—"} />
            <CompactMetric label="TG" value={tg ? score(derived.tgScore) : "—"} />
            <CompactMetric label="RISK" value={hasCoreData ? score(derived.socialRisk) : "—"} />
            <CompactMetric label="PRICE" value={market ? signedPct(priceChange) : "—"} />
          </div>
        </div>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-2 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
              placeholder="Solana mint / CA"
            />
          </div>
          <input
            value={options.symbol}
            onChange={(event) => setOptions((value) => ({ ...value, symbol: event.target.value }))}
            className={`${siteDesign.controls.inputClassName} lg:w-28`}
            placeholder="Ticker"
          />
          <select
            value={options.lookback}
            onChange={(event) => setOptions((value) => ({ ...value, lookback: event.target.value as Lookback }))}
            className={`${siteDesign.controls.inputClassName} lg:w-32`}
          >
            <option value="1">1 час</option>
            <option value="6">6 часов</option>
            <option value="24">24 часа</option>
            <option value="72">3 дня</option>
            <option value="168">7 дней</option>
            <option value="720">30 дней</option>
            <option value="all">Всё</option>
          </select>
          <button
            type="button"
            onClick={() => setFiltersOpen((value) => !value)}
            className={siteDesign.controls.actionButtonClassName}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Источники
          </button>
          <button disabled={loading || chainLoading} className={siteDesign.controls.primaryActionClassName}>
            {loading || chainLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            Анализ
          </button>
        </form>

        {filtersOpen ? (
          <div className="mt-3 grid gap-2 border-t border-bg-border pt-3 sm:grid-cols-2 xl:grid-cols-6">
            <Field label="X posts">
              <input
                type="number"
                min={10}
                max={100}
                value={options.xLimit}
                onChange={(event) => setOptions((value) => ({ ...value, xLimit: Math.max(10, Math.min(100, numberOr(event.target.value))) }))}
                className={siteDesign.controls.inputClassName}
              />
            </Field>
            <Field label="TG signals">
              <input
                type="number"
                min={20}
                max={500}
                value={options.tgLimit}
                onChange={(event) => setOptions((value) => ({ ...value, tgLimit: Math.max(20, Math.min(500, numberOr(event.target.value))) }))}
                className={siteDesign.controls.inputClassName}
              />
            </Field>
            <Field label="Min TG score">
              <input
                type="number"
                min={0}
                max={100}
                value={options.tgMinChannelScore}
                onChange={(event) => setOptions((value) => ({ ...value, tgMinChannelScore: clamp(numberOr(event.target.value)) }))}
                className={siteDesign.controls.inputClassName}
              />
            </Field>
            <Check label="Verified X only" value={options.xVerifiedOnly} set={(checked) => setOptions((value) => ({ ...value, xVerifiedOnly: checked }))} />
            <Check label="Exclude suspicious X" value={options.xExcludeSuspicious} set={(checked) => setOptions((value) => ({ ...value, xExcludeSuspicious: checked }))} />
            <Check label="Explicit TG calls" value={options.tgExplicitCallsOnly} set={(checked) => setOptions((value) => ({ ...value, tgExplicitCallsOnly: checked }))} />
          </div>
        ) : null}

        {mint ? (
          <SourceHealthBar
            x={x}
            tg={tg}
            market={market}
            chain={chain}
            ai={ai}
            loading={loading}
            chainLoading={chainLoading}
            aiLoading={aiLoading}
            sourceErrors={sourceErrors}
          />
        ) : null}
      </section>

      {error ? <Notice text={error} /> : null}

      {mint ? <SocialAnalysisChart mint={mint} symbol={symbol} /> : null}

      {mint ? (
        <OverallVerdict
          derived={derived}
          x={x}
          tg={tg}
          market={market}
          chain={chain}
          ai={ai}
          loading={loading || chainLoading}
        />
      ) : null}

      {mint ? (
        <CoreInsights
          x={x}
          tg={tg}
          chain={chain}
          market={market}
          derived={derived}
          sourceErrors={sourceErrors}
          loading={loading}
          chainLoading={chainLoading}
        />
      ) : null}

      {mint ? <QwenStrip ai={ai} loading={aiLoading} snapshot={snapshot} /> : null}

      {mint ? (
        <section className="surface-panel rounded-2xl border border-bg-border">
          <button
            type="button"
            onClick={() => setTechnicalOpen((value) => !value)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          >
            <div>
              <h2 className="text-xs font-semibold text-content">Все параметры</h2>
              <div className="mt-0.5 text-[10px] text-content-faint">
                Технические детали не монтируются, пока блок закрыт: 129+ метрик, graph snapshot и reasoning Qwen.
              </div>
            </div>
            {technicalOpen ? <ChevronUp className="h-4 w-4 text-content-muted" /> : <ChevronDown className="h-4 w-4 text-content-muted" />}
          </button>

          {technicalOpen ? (
            <div className="space-y-4 border-t border-bg-border p-4">
              <div className="grid gap-4 xl:grid-cols-2">
                {derived.groups.map((group) => (
                  <MetricTable key={group.title} title={group.title} rows={group.rows} />
                ))}
              </div>
              <TechnicalIntelligence ai={ai} snapshot={snapshot} warnings={warnings} sourceErrors={sourceErrors} />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[9px] font-semibold uppercase tracking-wider text-content-faint">{label}</span>
      {children}
    </label>
  );
}

function Check({ label, value, set }: { label: string; value: boolean; set: (value: boolean) => void }) {
  return (
    <label className="flex min-h-10 items-center gap-2 rounded-xl border border-bg-border bg-bg-card px-3 text-[11px] text-content-muted">
      <input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} />
      {label}
    </label>
  );
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-card px-2.5 py-1.5">
      <span className="text-[8px] font-semibold uppercase tracking-wider text-content-faint">{label}</span>
      <span className="ml-2 font-mono text-[11px] font-bold text-content">{value}</span>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {text}
    </div>
  );
}

function SourceHealthBar({
  x,
  tg,
  market,
  chain,
  ai,
  loading,
  chainLoading,
  aiLoading,
  sourceErrors,
}: {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  market: Market | null;
  chain: ChainAnalysis | null;
  ai: AiEnvelope | null;
  loading: boolean;
  chainLoading: boolean;
  aiLoading: boolean;
  sourceErrors: SourceErrors;
}) {
  const collector = telegramCollector(tg);
  const xMeta = twitterCollectionMeta(x);
  const xState: SourceState = loading ? "loading" : sourceErrors.x ? "error" : x ? "ready" : "idle";
  const tgState: SourceState = loading
    ? "loading"
    : sourceErrors.tg
      ? "error"
      : tg
        ? collector?.configured === false
          ? "degraded"
          : "ready"
        : "idle";
  const marketState: SourceState = loading
    ? "loading"
    : sourceErrors.market
      ? "error"
      : market
        ? market.meta?.stale === true
          ? "degraded"
          : "ready"
        : "idle";
  const chainState: SourceState = chainLoading ? "loading" : sourceErrors.chain ? "error" : chain ? "ready" : "idle";
  const aiState: SourceState = aiLoading ? "loading" : ai?.error || ai?.available === false ? "degraded" : ai?.result ? "ready" : "idle";

  return (
    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-bg-border pt-3" data-tag="trade.social_source_health.v1">
      <SourcePill
        label="X"
        state={xState}
        detail={x
          ? `${x.collectionStrategy || "collector"}${xMeta?.authenticatedBrowser ? " · auth" : ""}`
          : sourceErrors.x ? "ошибка" : "нет данных"}
      />
      <SourcePill label="Telegram" state={tgState} detail={telegramCollectorLabel(collector)} />
      <SourcePill
        label="Market"
        state={marketState}
        detail={market?.meta?.source ? `${market.meta.source}${market.meta.stale ? " · stale" : ""}` : sourceErrors.market ? "ошибка" : "нет данных"}
      />
      <SourcePill
        label="Chain"
        state={chainState}
        detail={chain ? `${chain.summary?.totalTrades ?? chain.trades?.length ?? 0} trades` : sourceErrors.chain ? "ошибка" : "нет данных"}
      />
      <SourcePill
        label="Qwen"
        state={aiState}
        detail={ai?.model || ai?.provider || ai?.agent || (aiLoading ? "analysis" : "ожидание")}
      />
    </div>
  );
}

function SourcePill({ label, state, detail }: { label: string; state: SourceState; detail: string }) {
  const stateClass = state === "ready"
    ? "border-success-border bg-success-soft text-success"
    : state === "error"
      ? "border-danger-border bg-danger-soft text-danger"
      : state === "degraded"
        ? "border-warning-border bg-warning-soft text-warning"
        : state === "loading"
          ? "border-primary-border bg-primary-soft text-primary"
          : "border-bg-border bg-bg-card text-content-faint";
  const dotClass = state === "ready"
    ? "bg-success"
    : state === "error"
      ? "bg-danger"
      : state === "degraded"
        ? "bg-warning"
        : state === "loading"
          ? "animate-pulse bg-primary"
          : "bg-content-faint";

  return (
    <div className={`inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] ${stateClass}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span className="font-semibold uppercase tracking-wider">{label}</span>
      <span className="max-w-48 truncate opacity-80">{detail}</span>
    </div>
  );
}

function OverallVerdict({
  derived,
  x,
  tg,
  market,
  chain,
  ai,
  loading,
}: {
  derived: ReturnType<typeof deriveSocialMetrics>;
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  market: Market | null;
  chain: ChainAnalysis | null;
  ai: AiEnvelope | null;
  loading: boolean;
}) {
  const sourceCount = [x, tg, market, chain].filter(Boolean).length;
  const marketUsable = Boolean(market && market.meta?.stale !== true);
  const highRisk = derived.socialRisk >= 68 || derived.manipulation >= 65;
  const strongSignal = sourceCount >= 2 && derived.socialScore >= 65 && derived.socialRisk < 50;

  let tone: InsightTone = "neutral";
  let title = "Недостаточно данных";
  let text = loading
    ? "Источники ещё собираются. Итог появится после детерминированного расчёта Telegram, X, рынка и on-chain данных."
    : "Недостаточно независимых источников, чтобы считать итоговый social score надёжным.";

  if (!loading && sourceCount > 0 && highRisk) {
    tone = "danger";
    title = "Повышенный риск";
    text = "Детерминированные метрики показывают повышенный social/manipulation risk. Сильная активность здесь не равна качественному сигналу.";
  } else if (!loading && strongSignal) {
    tone = "positive";
    title = "Сигнал подтверждается несколькими источниками";
    text = "Social activity поддерживается несколькими доступными источниками, а текущий risk score не перекрывает этот сигнал. Проверяй тайминг и on-chain структуру перед выводом.";
  } else if (!loading && sourceCount >= 2) {
    tone = "warning";
    title = "Смешанная картина";
    text = "Источников достаточно для анализа, но сила social signal и риск не дают однозначного подтверждения. Смотри Telegram/X/Blockchain выводы ниже.";
  }

  const classes = toneClasses(tone);
  return (
    <section className={`surface-panel rounded-2xl border p-4 ${classes.border}`} data-tag="trade.social_overall_verdict.v1">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${classes.dot}`} />
            <h2 className="text-sm font-semibold text-content">{title}</h2>
            {sourceCount > 0 ? (
              <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${classes.badge}`}>
                SOCIAL {score(derived.socialScore)} · RISK {score(derived.socialRisk)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-content-soft">{text}</p>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-content-muted sm:grid-cols-4 lg:grid-cols-2">
          <span>Coverage</span><span className="text-right font-mono text-content">{sourceCount}/4</span>
          <span>Manipulation</span><span className="text-right font-mono text-content">{sourceCount ? score(derived.manipulation) : "—"}</span>
          <span>Market</span><span className="text-right font-mono text-content">{marketUsable ? "fresh" : market ? "stale" : "—"}</span>
          <span>Qwen</span><span className="text-right font-mono text-content">{ai?.result ? "ready" : ai?.error ? "degraded" : "—"}</span>
        </div>
      </div>
    </section>
  );
}

function CoreInsights({
  x,
  tg,
  chain,
  market,
  derived,
  sourceErrors,
  loading,
  chainLoading,
}: {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  chain: ChainAnalysis | null;
  market: Market | null;
  derived: ReturnType<typeof deriveSocialMetrics>;
  sourceErrors: SourceErrors;
  loading: boolean;
  chainLoading: boolean;
}) {
  const collector = telegramCollector(tg);
  const xMeta = twitterCollectionMeta(x);
  const tgMessages = (tg?.timeline || []).filter((item) => !item.platform || item.platform.toLowerCase() === "telegram").length;
  const tgMatches = Number(tg?.meta?.matchedPlatforms?.telegram ?? tg?.meta?.matchedBeforeLimit ?? tg?.mentions ?? 0) || 0;
  const xPosts = x?.topTweets?.length ?? 0;
  const xUniverse = x?.riskUniverse?.totalTweets ?? x?.totalTweets ?? 0;
  const chainWallets = chain?.wallets || [];
  const washWallets = chainWallets.filter((wallet) => wallet.isWashTrader === true).length;
  const smartWallets = chainWallets.filter((wallet) => wallet.smartClassificationAvailable && wallet.isSmart === true).length;
  const freshWallets = chainWallets.filter((wallet) => wallet.freshnessVerified && wallet.isFresh === true).length;
  const bundles = chain?.bundles?.length ?? 0;
  const trades = chain?.summary?.totalTrades ?? chain?.trades?.length ?? 0;
  const wallets = chain?.summary?.uniqueWallets ?? chainWallets.length;
  const tgFailure = friendlySourceError("Telegram", sourceErrors.tg);
  const xFailure = friendlySourceError("X", sourceErrors.x);
  const chainFailure = friendlySourceError("Blockchain", sourceErrors.chain);

  const tgVerdict = tgFailure
    ? tgFailure
    : !tg
      ? loading
        ? "Загружаем Telegram timeline…"
        : "Telegram payload пока не получен."
      : tgMatches > 0
        ? derived.tgScore >= 70
          ? "В Telegram сильный сигнал: релевантные упоминания поддержаны заметной активностью источников."
          : derived.tgScore >= 45
            ? "В Telegram есть рабочий сигнал, но сила и качество источников смешанные."
            : "Упоминания есть, но Telegram-сигнал пока слабый и требует подтверждения."
        : collector?.mtproto_configured && !collector?.session_configured
          ? "Telegram API настроен, но MTProto user session ещё не авторизована — покрытие приватных/обычных каналов неполное."
          : collector?.configured
            ? "Фидер доступен, но по этому mint в выбранном окне релевантных совпадений не найдено."
            : "Telegram collector не настроен: это проблема покрытия, а не доказательство отсутствия сообщений.";

  const tgTone: InsightTone = tgFailure
    ? "danger"
    : collector?.mtproto_configured && !collector?.session_configured
      ? "warning"
      : tgMatches > 0 && derived.tgScore >= 60
        ? "positive"
        : tgMatches > 0
          ? "warning"
          : "neutral";

  const xVerdict = xFailure
    ? xFailure
    : !x
      ? loading
        ? "Загружаем X mentions…"
        : "X payload пока не получен."
      : xUniverse === 0
        ? "По выбранному периоду X не дал релевантных упоминаний."
        : derived.manipulation >= 55
          ? "В X есть активность, но структура выглядит подозрительно: повышен manipulation/bot risk."
          : derived.xScore >= 65
            ? "В X заметный органический импульс: интерес и вовлечённость подтверждают социальный спрос."
            : "X активен умеренно: сигнал есть, но пока без сильного подтверждения импульса.";

  const xTone: InsightTone = xFailure
    ? "danger"
    : derived.manipulation >= 55
      ? "warning"
      : x && derived.xScore >= 60
        ? "positive"
        : "neutral";

  const chainVerdict = chainFailure
    ? chainFailure
    : !chain
      ? chainLoading
        ? "Собираем Helius trade history и кошельки…"
        : "On-chain payload пока не получен."
      : washWallets > 0
        ? `Найдены wash-признаки у ${washWallets} кошельков — on-chain риск повышен.`
        : bundles > 0
          ? `Обнаружено ${bundles} синхронных buy-кластеров. Это не доказательство манипуляции, но требует проверки.`
          : smartWallets > 0
            ? `Есть ${smartWallets} верифицированных smart-wallet сигналов без явных wash-признаков в выборке.`
            : trades > 0
              ? "Торговая активность подтверждена; явных on-chain аномалий в доступной выборке не видно."
              : "On-chain данных для уверенного вывода пока мало.";

  const chainTone: InsightTone = chainFailure
    ? "danger"
    : washWallets > 0 || bundles > 0
      ? "warning"
      : trades > 0
        ? "positive"
        : "neutral";

  return (
    <section className="grid gap-4 lg:grid-cols-3" data-tag="trade.social_core_insights.v2">
      <InsightCard
        icon={<Send />}
        title="Telegram"
        badge={tg ? score(derived.tgScore) : "—"}
        verdict={tgVerdict}
        tone={tgTone}
        facts={[
          `${tgMessages} сообщений в UI · ${tgMatches} совпадений до лимита`,
          `Фидер: ${telegramCollectorLabel(collector)}`,
          `Каналов: ${collector?.monitored_channels ?? collector?.public_web_channels ?? "—"}`,
          `Первый сигнал: ${tg?.origin?.source_handle || tg?.origin?.source_name || "—"}`,
          collector?.last_scan_at ? `Последний scan: ${formatAgo(collector.last_scan_at)}` : null,
          collector?.last_error ? `Feeder error: ${collector.last_error}` : null,
        ]}
      />

      <InsightCard
        icon={<Twitter />}
        title="Twitter / X"
        badge={x ? score(derived.xScore) : "—"}
        verdict={xVerdict}
        tone={xTone}
        facts={[
          `${xPosts} отображаемых постов · ${xUniverse} в risk-universe`,
          `${x?.uniqueMentioners ?? 0} уникальных авторов`,
          `Engagement: ${x?.aggregated?.totalEngagement ?? 0}`,
          `Bot risk: ${score(x?.riskUniverse?.botRiskScore ?? x?.botRiskScore ?? 0)}`,
          x ? `Collector: ${x.collectionStrategy || "auto"} · browser ${xMeta?.authenticatedBrowser ? "auth" : "public"}` : null,
          xMeta?.coverageConfirmed === false ? "Coverage: ограниченная выборка" : null,
        ]}
      />

      <InsightCard
        icon={<WalletCards />}
        title="Blockchain"
        badge={chain ? `${trades} trades` : "—"}
        verdict={chainVerdict}
        tone={chainTone}
        facts={[
          `${trades} трейдов · ${wallets} кошельков`,
          `${washWallets} wash · ${smartWallets} smart · ${freshWallets} fresh`,
          `${bundles} синхронных buy-кластеров`,
          `Цена: ${signedPct(market?.pair?.changeH1 ?? market?.pair?.change24h ?? null)}`,
          chain?.truncated || chain?.summary?.historyTruncated ? "История обрезана — вывод ограничен выборкой" : null,
        ]}
      />
    </section>
  );
}

function toneClasses(tone: InsightTone): { border: string; badge: string; dot: string } {
  if (tone === "positive") {
    return {
      border: "border-success-border",
      badge: "border-success-border bg-success-soft text-success",
      dot: "bg-success",
    };
  }
  if (tone === "warning") {
    return {
      border: "border-warning-border",
      badge: "border-warning-border bg-warning-soft text-warning",
      dot: "bg-warning",
    };
  }
  if (tone === "danger") {
    return {
      border: "border-danger-border",
      badge: "border-danger-border bg-danger-soft text-danger",
      dot: "bg-danger",
    };
  }
  return {
    border: "border-bg-border",
    badge: "border-bg-border bg-bg-elevated text-content-muted",
    dot: "bg-content-faint",
  };
}

function InsightCard({
  icon,
  title,
  badge,
  verdict,
  facts,
  tone,
}: {
  icon: ReactNode;
  title: string;
  badge: string;
  verdict: string;
  facts: Array<string | null>;
  tone: InsightTone;
}) {
  const classes = toneClasses(tone);
  return (
    <article className={`surface-panel rounded-2xl border p-4 ${classes.border}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-content">
          <span className="text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${classes.badge}`}>{badge}</span>
      </div>
      <p className="mt-3 min-h-[64px] text-sm leading-6 text-content-soft">{verdict}</p>
      <div className="mt-3 space-y-1.5 border-t border-bg-border pt-3">
        {facts.filter((value): value is string => Boolean(value)).map((fact, index) => (
          <div key={`${index}-${fact}`} className="flex items-start gap-2 text-[10px] leading-4 text-content-muted">
            <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${classes.dot}`} />
            <span>{fact}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function QwenStrip({
  ai,
  loading,
  snapshot,
}: {
  ai: AiEnvelope | null;
  loading: boolean;
  snapshot: AnalysisSnapshot | null;
}) {
  const summary = ai?.result?.summary;
  const confidence = confidencePercent(ai?.result?.overallConfidence);
  const risks = ai?.result?.risks?.length ?? 0;
  const coordination = ai?.result?.coordinationSignals?.length ?? 0;
  return (
    <section className="surface-panel rounded-2xl border border-bg-border px-4 py-3" data-tag="trade.social_qwen_verdict.v2">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <BrainCircuit className={`mt-0.5 h-4 w-4 shrink-0 ${loading ? "animate-pulse text-primary" : "text-primary"}`} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold text-content">Qwen verdict</h2>
              {confidence != null ? (
                <span className="font-mono text-[9px] text-content-faint">confidence {confidence}%</span>
              ) : null}
              {ai?.model ? <span className="font-mono text-[9px] text-content-faint">{ai.model}</span> : null}
            </div>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              {loading
                ? "Core-data уже показаны. Qwen анализирует unified snapshot в фоне интерфейса."
                : summary
                  ? summary
                  : ai?.error
                    ? `Qwen недоступен: ${ai.error}`
                    : snapshot
                      ? "Snapshot собран; AI-вывод появится при наличии аналитических features."
                      : "Ожидается unified snapshot."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3 font-mono text-[9px] text-content-faint">
          {snapshot ? <span>{snapshot.featureCount - snapshot.missingFeatureCount}/{snapshot.featureCount} features</span> : null}
          {ai?.result ? <span>{risks} risks · {coordination} coordination</span> : null}
          {ai?.latencyMs != null ? <span>{ai.latencyMs} ms</span> : null}
        </div>
      </div>
    </section>
  );
}

function MetricTable({ title, rows }: { title: string; rows: Metric[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-bg-border">
      <div className="border-b border-bg-border bg-bg-elevated/50 px-3 py-2 text-xs font-semibold text-content">{title}</div>
      <div className="divide-y divide-bg-border">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_minmax(90px,.8fr)] gap-3 px-3 py-2 text-[11px]">
            <div>
              <div className="text-content-muted">{row.label}</div>
              {row.note ? <div className="mt-0.5 text-[9px] text-content-faint">{row.note}</div> : null}
            </div>
            <div className="break-words text-right font-mono font-semibold text-content">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TechnicalIntelligence({
  ai,
  snapshot,
  warnings,
  sourceErrors,
}: {
  ai: AiEnvelope | null;
  snapshot: AnalysisSnapshot | null;
  warnings: string[];
  sourceErrors: SourceErrors;
}) {
  const diagnostics = [...new Set([
    friendlySourceError("Telegram", sourceErrors.tg),
    friendlySourceError("X", sourceErrors.x),
    friendlySourceError("Market", sourceErrors.market),
    friendlySourceError("Blockchain", sourceErrors.chain),
    ...warnings,
  ].filter((value): value is string => Boolean(value)))];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-bg-border bg-bg-card p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-semibold text-content">Qwen reasoning</h3>
        </div>
        <div className="mt-2 space-y-2">
          {(ai?.result?.reasoningSummary || []).length ? (
            (ai?.result?.reasoningSummary || []).slice(0, 8).map((item, index) => (
              <div key={`${index}-${item.slice(0, 24)}`} className="text-[11px] leading-5 text-content-muted">• {item}</div>
            ))
          ) : (
            <div className="text-[11px] text-content-faint">Нет reasoning summary.</div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-bg-border bg-bg-card p-3">
        <div className="flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-semibold text-content">Snapshot / diagnostics</h3>
        </div>
        <div className="mt-2 space-y-1.5 text-[11px] text-content-muted">
          <div>Features: <span className="font-mono text-content">{snapshot ? `${snapshot.featureCount - snapshot.missingFeatureCount}/${snapshot.featureCount}` : "—"}</span></div>
          <div>Graph nodes: <span className="font-mono text-content">{snapshot?.graph.stats.nodes ?? "—"}</span></div>
          <div>Graph edges: <span className="font-mono text-content">{snapshot?.graph.stats.edges ?? "—"}</span></div>
          <div>Qwen provider: <span className="font-mono text-content">{ai?.provider || ai?.agent || "—"}</span></div>
          <div>Qwen latency: <span className="font-mono text-content">{ai?.latencyMs != null ? `${ai.latencyMs} ms` : "—"}</span></div>
          {diagnostics.length ? (
            <div className="mt-2 rounded-lg border border-warning-border bg-warning-soft p-2 text-warning">
              {diagnostics.join(" · ")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
