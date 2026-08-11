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
  Gauge,
  Loader2,
  Network,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Twitter,
  Zap,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";
import {
  DEFAULT_SOCIAL_OPTIONS,
  IMPULSE_THRESHOLD_PCT,
  MINT_RE,
  clamp,
  deriveSocialMetrics,
  numberOr,
  pct,
  score,
  signedPct,
  toTimestamp,
  upsertWarning,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type Lookback,
  type Market,
  type Metric,
  type PriceSocial,
  type SocialOptions,
  type SocialTimeline,
  type TimelineItem,
  type TwitterStats,
} from "@/lib/trade/social-intelligence";
import {
  buildSocialSourceParams,
  fetchJson,
  readChainStream,
} from "@/lib/trade/social-intelligence-api";

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");

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
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void fetchJson<{ items: Channel[] }>(`${BACKEND}/api/v1/telegram/channels?limit=100`)
      .then((value) => setChannels(Array.isArray(value.items) ? value.items : []))
      .catch(() => {});
  }, []);

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
      setError(null);
      setWarnings([]);
      setX(null);
      setTg(null);
      setMarket(null);
      setChain(null);
      setAi(null);
      router.replace(`/trade/analysis/social?mint=${encodeURIComponent(contract)}`, { scroll: false });

      const { x: xParams, tg: tgParams } = buildSocialSourceParams(contract, options);

      void readChainStream(contract, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setChain(value);
        })
        .catch((chainError: unknown) => {
          if (controller.signal.aborted) return;
          const message = chainError instanceof Error ? chainError.message : "недоступна";
          setWarnings((value) => upsertWarning(value, `Trade history: ${message}`));
        })
        .finally(() => {
          if (!controller.signal.aborted) setChainLoading(false);
        });

      const [xResult, tgResult, marketResult] = await Promise.allSettled([
        fetchJson<TwitterStats>(`/api/trade/dev-twitter?${xParams}`, controller.signal),
        fetchJson<SocialTimeline>(
          `${BACKEND}/api/v1/social/token/${encodeURIComponent(contract)}?${tgParams}`,
          controller.signal,
        ),
        fetchJson<Market>(`/api/token-ohlcv?mint=${encodeURIComponent(contract)}`, controller.signal),
      ]);
      if (controller.signal.aborted) return;

      const nextX = xResult.status === "fulfilled" ? xResult.value : null;
      const nextTg = tgResult.status === "fulfilled" ? tgResult.value : null;
      const nextMarket = marketResult.status === "fulfilled" ? marketResult.value : null;
      setX(nextX);
      setTg(nextTg);
      setMarket(nextMarket);

      const sourceWarnings = [
        !nextX ? "X: недоступен" : null,
        !nextTg ? "Telegram: недоступен" : null,
        !nextMarket ? "Market: недоступен" : null,
      ].filter((value): value is string => value != null);
      setWarnings((value) => sourceWarnings.reduce(upsertWarning, value));

      if (!nextX && !nextTg) {
        setError("Нет данных X и Telegram");
        setLoading(false);
        return;
      }

      const telegramItems = (nextTg?.timeline || []).filter(
        (item) => !item.platform || item.platform.toLowerCase() === "telegram",
      );
      if (telegramItems.length) {
        try {
          const qwen = await fetchJson<AiEnvelope>("/api/trade/social-ai", controller.signal, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mint: contract,
              symbol: nextX?.symbol || options.symbol,
              tokenName: nextMarket?.pair?.name,
              timeline: telegramItems,
            }),
          });
          if (!controller.signal.aborted) setAi(qwen);
        } catch (aiError: unknown) {
          if (!controller.signal.aborted) {
            const message = aiError instanceof Error ? aiError.message : "AI недоступен";
            setWarnings((value) => upsertWarning(value, `Qwen: ${message}`));
            setAi({ agent: "qwen", available: false, error: message });
          }
        }
      }

      if (!controller.signal.aborted) setLoading(false);
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

  return (
    <div className="space-y-5" data-tag="trade.social_intelligence.v6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold text-content">Social Intelligence · X + Telegram + Qwen</h1>
          </div>
          <p className="mt-1 text-xs text-content-muted">Social-метрики, Telegram AI и Price ↔ Social по реальным on-chain timestamps.</p>
        </div>
        {mint && <div className="font-mono text-[10px] text-content-faint">{mint.slice(0, 8)}…{mint.slice(-7)}</div>}
      </header>

      <form onSubmit={submit} className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="grid gap-3 lg:grid-cols-[1.5fr_.55fr_.55fr_.45fr]">
          <Field label="Solana mint / CA">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} className={`${siteDesign.controls.inputClassName} pl-9 font-mono`} placeholder="Вставь contract" />
            </div>
          </Field>
          <Field label="Ticker"><input value={options.symbol} onChange={(event) => setOptions((value) => ({ ...value, symbol: event.target.value }))} className={siteDesign.controls.inputClassName} placeholder="BONK" /></Field>
          <Field label="Период"><select value={options.lookback} onChange={(event) => setOptions((value) => ({ ...value, lookback: event.target.value as Lookback }))} className={siteDesign.controls.inputClassName}>{[["1", "1 час"], ["6", "6 часов"], ["24", "24 часа"], ["72", "3 дня"], ["168", "7 дней"], ["720", "30 дней"], ["all", "Всё"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <div className="flex items-end"><button disabled={loading} className={`${siteDesign.controls.primaryActionClassName} w-full`}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />} Анализ</button></div>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-content-muted">Фильтры источников</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="X posts"><input type="number" min={10} max={100} value={options.xLimit} onChange={(event) => setOptions((value) => ({ ...value, xLimit: Math.max(10, Math.min(100, numberOr(event.target.value))) }))} className={siteDesign.controls.inputClassName} /></Field>
            <Field label="TG signals"><input type="number" min={20} max={500} value={options.tgLimit} onChange={(event) => setOptions((value) => ({ ...value, tgLimit: Math.max(20, Math.min(500, numberOr(event.target.value))) }))} className={siteDesign.controls.inputClassName} /></Field>
            <Field label="Min TG score"><input type="number" min={0} max={100} value={options.tgMinChannelScore} onChange={(event) => setOptions((value) => ({ ...value, tgMinChannelScore: clamp(numberOr(event.target.value)) }))} className={siteDesign.controls.inputClassName} /></Field>
            <Check label="Verified X only" value={options.xVerifiedOnly} set={(checked) => setOptions((value) => ({ ...value, xVerifiedOnly: checked }))} />
            <Check label="Exclude suspicious X" value={options.xExcludeSuspicious} set={(checked) => setOptions((value) => ({ ...value, xExcludeSuspicious: checked }))} />
            <Check label="Explicit TG calls" value={options.tgExplicitCallsOnly} set={(checked) => setOptions((value) => ({ ...value, tgExplicitCallsOnly: checked }))} />
          </div>
        </details>
      </form>

      {error && <Notice tone="danger" text={error} />}
      {warnings.length > 0 && <Notice tone="warning" text={warnings.join(" · ")} />}

      {(x || tg) && <>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-9">
          <Kpi label="Social score" value={score(derived.socialScore)} icon={<Gauge />} />
          <Kpi label="X score" value={score(derived.xScore)} icon={<Twitter />} />
          <Kpi label="TG score" value={score(derived.tgScore)} icon={<Send />} />
          <Kpi label="Organic" value={score(derived.organic)} icon={<Sparkles />} />
          <Kpi label="Manipulation" value={score(derived.manipulation)} icon={<ShieldAlert />} />
          <Kpi label="Social risk" value={score(derived.socialRisk)} icon={<ShieldAlert />} />
          <Kpi label="Early" value={score(derived.early)} icon={<Zap />} />
          <Kpi label="Alpha" value={score(derived.alpha)} icon={<Radar />} />
          <Kpi label="AI confidence" value={ai?.result?.overallConfidence != null ? pct(ai.result.overallConfidence * 100) : "—"} icon={<BrainCircuit />} />
        </section>
        <PricePanel price={derived.price} loading={chainLoading} />
        <section className="surface-panel rounded-2xl border border-bg-border p-4">
          <div className="mb-3 flex items-center justify-between">
            <div><h2 className="text-sm font-semibold text-content">Все параметры</h2><p className="text-[10px] text-content-faint">Поля без достаточной выборки остаются «—» — случайные значения не используются.</p></div>
            <button type="button" onClick={() => void run(mint)} disabled={loading || !mint} className={siteDesign.controls.actionButtonClassName}><RefreshCw className="h-4 w-4" />Обновить</button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">{derived.groups.map((group) => <MetricTable key={group.title} title={group.title} rows={group.rows} />)}</div>
        </section>
        <AiPanel ai={ai} />
        <TimelinePanel x={x} tg={tg} impulseAt={derived.price.impulseTime} impulseChange={derived.price.impulseChange} />
      </>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">{label}</span>{children}</label>;
}
function Check({ label, value, set }: { label: string; value: boolean; set: (value: boolean) => void }) {
  return <label className="flex min-h-10 items-center gap-2 rounded-xl border border-bg-border bg-bg-card px-3 text-xs text-content-muted"><input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} />{label}</label>;
}
function Notice({ tone, text }: { tone: "danger" | "warning"; text: string }) {
  return <div className={`flex gap-2 rounded-xl border p-3 text-xs ${tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-warning/30 bg-warning/10 text-content-muted"}`}><AlertTriangle className="h-4 w-4 shrink-0" />{text}</div>;
}
function Kpi({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="surface-panel rounded-xl border border-bg-border p-3"><div className="flex items-center justify-between text-content-faint"><span className="text-[9px] uppercase tracking-wider">{label}</span><span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span></div><div className="mt-2 font-mono text-lg font-bold text-content">{value}</div></div>;
}
function MetricTable({ title, rows }: { title: string; rows: Metric[] }) {
  return <div className="overflow-hidden rounded-xl border border-bg-border"><div className="border-b border-bg-border bg-bg-elevated/60 px-3 py-2 text-xs font-semibold text-content">{title}</div><div className="divide-y divide-bg-border">{rows.map((row) => <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_minmax(90px,.8fr)] gap-3 px-3 py-2 text-[11px]"><div><div className="text-content-muted">{row.label}</div>{row.note && <div className="mt-0.5 text-[9px] text-content-faint">{row.note}</div>}</div><div className="break-words text-right font-mono font-semibold text-content">{row.value}</div></div>)}</div></div>;
}
function PricePanel({ price, loading }: { price: PriceSocial; loading: boolean }) {
  return <section className="surface-panel rounded-2xl border border-bg-border p-4"><div className="mb-3 flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /><div><h2 className="text-sm font-semibold text-content">Price ↔ Social lead/lag</h2><p className="text-[10px] text-content-faint">{loading ? "Trade history загружается параллельно — social уже доступен." : `Ближайший price impulse ≥ ${IMPULSE_THRESHOLD_PCT}% за 5 минут.`}</p></div></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8"><Kpi label="Direction" value={price.leadDirection} icon={<Zap />} /><Kpi label="Lead / lag" value={price.leadLagMinutes == null ? "—" : `${Math.abs(price.leadLagMinutes).toFixed(1)}m`} icon={<Gauge />} /><Kpi label="Confidence" value={score(price.leadLagConfidence)} icon={<Radar />} /><Kpi label="+5m" value={signedPct(price.reaction5)} icon={<TrendingUp />} /><Kpi label="+15m" value={signedPct(price.reaction15)} icon={<TrendingUp />} /><Kpi label="+1h" value={signedPct(price.reaction60)} icon={<TrendingUp />} /><Kpi label="Max up 1h" value={signedPct(price.maxUpside)} icon={<TrendingUp />} /><Kpi label="Max DD 1h" value={signedPct(price.maxDrawdown)} icon={<ShieldAlert />} /></div></section>;
}
function AiPanel({ ai }: { ai: AiEnvelope | null }) {
  const result = ai?.result;
  return <section className="surface-panel rounded-2xl border border-bg-border p-4"><div className="mb-3 flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold text-content">Qwen AI · Telegram second-stage analysis</h2></div>{!ai ? <div className="text-xs text-content-faint">AI запускается после Telegram сообщений.</div> : !result ? <div className="text-xs text-warning">Qwen недоступен: {ai.error || "нет результата"}</div> : <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]"><div><p className="text-sm leading-6 text-content-soft">{result.summary || "—"}</p><div className="mt-3 rounded-xl border border-bg-border bg-bg-card p-3"><div className="text-[10px] uppercase tracking-wider text-content-faint">Campaign narrative</div><div className="mt-1 text-xs leading-5 text-content-muted">{result.campaignHypothesis?.narrative || "—"}</div></div></div><div className="space-y-2">{(result.reasoningSummary || []).map((value, index) => <div key={`${index}-${value.slice(0, 24)}`} className="rounded-lg border border-bg-border bg-bg-elevated/50 px-3 py-2 text-xs text-content-muted">{value}</div>)}</div></div>}</section>;
}
function TimelinePanel({ x, tg, impulseAt, impulseChange }: { x: TwitterStats | null; tg: SocialTimeline | null; impulseAt: number | null; impulseChange: number | null }) {
  const items = useMemo(() => {
    const next: TimelineItem[] = [...(tg?.timeline || [])].filter((item) => toTimestamp(item.occurred_at) != null);
    for (const tweet of x?.topTweets || []) {
      const time = toTimestamp(tweet.timestamp);
      if (time == null) continue;
      next.push({ platform: "x", source_handle: tweet.author, source_name: null, source_url: null, text: tweet.text, occurred_at: new Date(time).toISOString(), metrics: { likes: tweet.likes, retweets: tweet.retweets, views: tweet.views } });
    }
    if (impulseAt != null) next.push({ platform: "price", source_handle: "on-chain", source_name: "price impulse", source_url: null, text: `Nearest 5m impulse: ${signedPct(impulseChange)}`, occurred_at: new Date(impulseAt).toISOString(), metrics: null });
    return next.sort((a, b) => numberOr(toTimestamp(a.occurred_at)) - numberOr(toTimestamp(b.occurred_at))).slice(-100);
  }, [x, tg, impulseAt, impulseChange]);

  return <section className="surface-panel rounded-2xl border border-bg-border p-4"><h2 className="text-sm font-semibold text-content">Signal timeline · TG → X → Price → Hype</h2><div className="mt-3 space-y-2">{items.length ? items.map((item) => <div key={`${item.platform}-${item.source_handle || item.source_name}-${item.occurred_at}-${item.text.slice(0, 32)}`} className="grid grid-cols-[70px_120px_1fr] gap-2 rounded-xl border border-bg-border bg-bg-card/50 p-2 text-[10px]"><div className="font-mono text-content-faint">{new Date(item.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div><div className="font-semibold text-content">{item.platform.toUpperCase()} · {item.source_handle || item.source_name || "source"}</div><div className="line-clamp-2 text-content-muted">{item.text}</div></div>) : <div className="text-xs text-content-faint">Нет timestamped сигналов.</div>}</div></section>;
}
