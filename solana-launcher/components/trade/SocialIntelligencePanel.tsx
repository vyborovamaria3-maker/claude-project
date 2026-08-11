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

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PRICE_IMPULSE_WINDOW_MS = 5 * 60_000;
const PRICE_IMPULSE_THRESHOLD_PCT = 10;

type Lookback = "1" | "6" | "24" | "72" | "168" | "720" | "all";

type Tweet = {
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  views: number;
  timestamp: number | null;
  isSuspicious: boolean;
};

type Shiller = {
  handle: string;
  tweets: number;
  totalEngagement: number;
  isBot: boolean;
  followers: number | null;
  postsCount: number | null;
  isVerified: boolean;
};

type TwitterStats = {
  symbol: string;
  mint: string;
  twitterHandle: string | null;
  totalTweets: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  uniqueMentioners: number;
  botRisk: "low" | "medium" | "high";
  botRiskScore: number;
  anomalyCount: number;
  topTweets: Tweet[];
  shillers: Shiller[];
  lastUpdated: number;
  collectionStrategy: string;
  performance: { responseTimeMs: number; cached: boolean };
  aggregated: {
    totalEngagement: number;
    engagementRate: number;
    verifiedAuthors: number;
    botSuspectedCount: number;
    botRatio: number;
  };
  discovery: {
    mentions: number;
    accounts: number;
    memecoinAccounts: number;
    firstAccountCreatedAt: number | null;
    lastDiscoveredAt: number | null;
  };
};

type TimelineItem = {
  platform: string;
  event_type?: string;
  source_handle: string | null;
  source_name: string | null;
  source_url: string | null;
  text: string;
  occurred_at: string;
  metrics: Record<string, unknown> | null;
};

type SocialTimeline = {
  mint_address: string;
  mentions: number;
  platforms: Record<string, number>;
  origin: TimelineItem | null;
  timeline: TimelineItem[];
};

type Channel = {
  id: number;
  username: string | null;
  title: string;
  participants: number;
  score: number;
  calls_count: number;
  win_rate: number;
  rug_rate: number;
  avg_roi: number;
};

type Market = {
  pair?: {
    symbol?: string;
    name?: string;
    priceUsd?: number;
    marketCap?: number;
    liquidityUsd?: number;
    volumeH24?: number;
    volumeH6?: number;
    volumeH1?: number;
    volumeM5?: number;
    change24h?: number;
    changeH1?: number;
    createdAt?: number | null;
  };
};

type ChainTrade = {
  ts: number;
  w?: string;
  t?: number;
  s?: number;
  n?: number;
  p: number;
  sig?: string;
  u?: number;
};

type ChainAnalysis = {
  summary?: {
    totalVolumeSol?: number;
    totalVolumeUsd?: number;
    totalTrades?: number;
    uniqueWallets?: number;
    periodStart?: number | null;
    periodEnd?: number | null;
    totalRawTrades?: number;
  };
  trades?: ChainTrade[];
  fetchedAt?: number;
  fromCache?: boolean;
  truncated?: boolean;
};

type AiResult = {
  summary: string;
  sentiment: { label: string; score: number; confidence: number };
  dominantIntent: string;
  coordinationSignals: Array<{
    type: string;
    severity: string;
    confidence: number;
    explanation: string;
    evidenceMessageIds: string[];
  }>;
  campaignHypothesis: {
    label: string;
    confidence: number;
    likelyOriginators: string[];
    amplifiers: string[];
    narrative: string;
    evidenceMessageIds: string[];
  };
  risks: Array<{
    type: string;
    severity: string;
    confidence: number;
    explanation: string;
    evidenceMessageIds: string[];
  }>;
  reasoningSummary: string[];
  overallConfidence: number;
  claims: Array<unknown>;
  entities: Array<unknown>;
  relationships: Array<unknown>;
};

type AiEnvelope = {
  agent: string;
  available: boolean;
  status?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  cache?: string;
  result?: AiResult;
  error?: string;
};

type Metric = {
  label: string;
  value: string;
  raw?: number | null;
  note?: string;
};

type Options = {
  symbol: string;
  lookback: Lookback;
  xLimit: number;
  xVerifiedOnly: boolean;
  xExcludeSuspicious: boolean;
  tgLimit: number;
  tgMinChannelScore: number;
  tgExplicitCallsOnly: boolean;
};

const DEFAULT: Options = {
  symbol: "",
  lookback: "24",
  xLimit: 40,
  xVerifiedOnly: false,
  xExcludeSuspicious: true,
  tgLimit: 200,
  tgMinChannelScore: 0,
  tgExplicitCallsOnly: false,
};

const num = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const clamp = (value: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

const compact = (value: number | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(num(value));

const pct = (value: number | null | undefined) =>
  Number.isFinite(Number(value)) ? `${num(value).toFixed(1)}%` : "—";

const signedPct = (value: number | null | undefined) =>
  Number.isFinite(Number(value))
    ? `${num(value) >= 0 ? "+" : ""}${num(value).toFixed(1)}%`
    : "—";

const score = (value: number | null | undefined) =>
  Number.isFinite(Number(value)) ? `${Math.round(num(value))}/100` : "—";

const money = (value: number | null | undefined) =>
  Number.isFinite(Number(value)) ? `$${compact(value)}` : "—";

const ago = (value: string | number | null | undefined) => {
  if (!value) return "—";
  let time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "—";
  if (time < 1e12) time *= 1000;
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

const ts = (value: string | number | null | undefined) => {
  if (!value) return null;
  let time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return time < 1e12 ? time * 1000 : time;
};

const avg = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const lookbackHours = (value: Lookback) => (value === "all" ? 720 : Number(value));

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/0x[a-f0-9]+/g, " ")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 220);

function sentiment(texts: string[]) {
  const positive =
    /\b(bull|bullish|buy|gem|moon|pump|breakout|alpha|early|strong|ape|send|upside|good|great|лонг|покуп|ракета|рост|гем)\b|🚀|🔥|📈|💎/i;
  const negative =
    /\b(rug|scam|dump|sell|exit|dead|avoid|warning|bear|rekt|скам|раг|слив|продаж|паден)\b|⚠|📉|☠/i;
  let p = 0;
  let n = 0;
  let u = 0;
  texts.forEach((text) => {
    const isPositive = positive.test(text);
    const isNegative = negative.test(text);
    if (isPositive && !isNegative) p += 1;
    else if (isNegative && !isPositive) n += 1;
    else u += 1;
  });
  const total = p + n + u;
  if (!total) return { label: "—", p: 0, n: 0, u: 0 };
  return {
    label: p / total > 0.52 ? "BULLISH" : n / total > 0.38 ? "BEARISH" : "MIXED",
    p: (p / total) * 100,
    n: (n / total) * 100,
    u: (u / total) * 100,
  };
}

function sentimentDelta(rows: Array<{ time: number | null; text: string }>) {
  const valid = rows
    .filter((row): row is { time: number; text: string } => row.time !== null)
    .sort((a, b) => a.time - b.time);
  if (valid.length < 4) return null;
  const mid = Math.floor(valid.length / 2);
  const early = sentiment(valid.slice(0, mid).map((row) => row.text));
  const recent = sentiment(valid.slice(mid).map((row) => row.text));
  return recent.p - early.p;
}

function countSince(times: Array<number | null>, minutes: number) {
  const cutoff = Date.now() - minutes * 60_000;
  return times.filter((value) => value !== null && value >= cutoff).length;
}

function firstTime(items: TimelineItem[]) {
  return Math.min(
    ...items
      .map((item) => ts(item.occurred_at))
      .filter((value): value is number => value !== null),
    Infinity,
  );
}

function safeLag(first: number, second: number) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return "—";
  const minutes = Math.round((second - first) / 60_000);
  if (minutes === 0) return "same minute";
  return minutes > 0 ? `${minutes}m later` : `${Math.abs(minutes)}m earlier`;
}

function densestWindowTime(times: number[], windowMs = 5 * 60_000) {
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  let bestStart = 0;
  let bestEnd = 0;
  let end = 0;
  for (let start = 0; start < sorted.length; start += 1) {
    if (end < start) end = start;
    while (end + 1 < sorted.length && sorted[end + 1] - sorted[start] <= windowMs) {
      end += 1;
    }
    if (end - start > bestEnd - bestStart) {
      bestStart = start;
      bestEnd = end;
    }
  }
  return sorted[Math.floor((bestStart + bestEnd) / 2)];
}

function normalizeTrades(chain: ChainAnalysis | null) {
  return (chain?.trades || [])
    .map((trade) => ({
      time: ts(trade.ts),
      price: num(trade.p, NaN),
    }))
    .filter(
      (trade): trade is { time: number; price: number } =>
        trade.time !== null && Number.isFinite(trade.price) && trade.price > 0,
    )
    .sort((a, b) => a.time - b.time);
}

function priceAtOrBefore(
  trades: Array<{ time: number; price: number }>,
  target: number,
) {
  let found: { time: number; price: number } | null = null;
  for (const trade of trades) {
    if (trade.time > target) break;
    found = trade;
  }
  return found;
}

function priceAtOrAfter(
  trades: Array<{ time: number; price: number }>,
  target: number,
) {
  return trades.find((trade) => trade.time >= target) || null;
}

function priceAround(
  trades: Array<{ time: number; price: number }>,
  target: number,
) {
  return priceAtOrBefore(trades, target) || priceAtOrAfter(trades, target);
}

function changeBetween(
  base: { price: number } | null,
  next: { price: number } | null,
) {
  if (!base || !next || base.price <= 0) return null;
  return ((next.price - base.price) / base.price) * 100;
}

function findPriceImpulseNear(
  trades: Array<{ time: number; price: number }>,
  targetTime: number | null,
  windowMs = PRICE_IMPULSE_WINDOW_MS,
  thresholdPct = PRICE_IMPULSE_THRESHOLD_PCT,
  searchRadiusMs = 6 * 60 * 60_000,
) {
  if (trades.length < 2) return null;
  const candidates: Array<{ time: number; change: number; direction: "UP" | "DOWN" }> = [];
  for (const trade of trades) {
    if (
      targetTime !== null &&
      Math.abs(trade.time - targetTime) > searchRadiusMs
    ) {
      continue;
    }
    const base = priceAtOrBefore(trades, trade.time - windowMs);
    if (!base || base.price <= 0) continue;
    const change = ((trade.price - base.price) / base.price) * 100;
    if (Math.abs(change) >= thresholdPct) {
      candidates.push({
        time: trade.time,
        change,
        direction: change >= 0 ? "UP" : "DOWN",
      });
    }
  }
  if (!candidates.length) return null;
  if (targetTime === null) return candidates[0];
  return candidates.sort(
    (a, b) => Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime),
  )[0];
}

async function json<T>(url: string, signal?: AbortSignal, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    signal,
    ...init,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
  }
  return data as T;
}

async function analyzeStream(mint: string, signal: AbortSignal) {
  const response = await fetch(
    `/api/trade/analyze-stream?mint=${encodeURIComponent(mint)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`analyze-stream HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: ChainAnalysis | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "error") {
        throw new Error(String(event.message || "on-chain analysis failed"));
      }
      if (event.type === "final") {
        const { type: _type, ...payload } = event;
        final = payload as unknown as ChainAnalysis;
      }
    }
  }
  return final;
}

export default function SocialIntelligencePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("mint")?.trim() || "";

  const [query, setQuery] = useState(initial);
  const [mint, setMint] = useState(initial);
  const [options, setOptions] = useState<Options>(DEFAULT);
  const [x, setX] = useState<TwitterStats | null>(null);
  const [tg, setTg] = useState<SocialTimeline | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [market, setMarket] = useState<Market | null>(null);
  const [chain, setChain] = useState<ChainAnalysis | null>(null);
  const [ai, setAi] = useState<AiEnvelope | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void json<{ items: Channel[] }>(
      `${BACKEND}/api/v1/telegram/channels?limit=100`,
    )
      .then((value) => setChannels(value.items || []))
      .catch(() => {});
  }, []);

  const run = useCallback(
    async (next: string) => {
      const ca = next.trim();
      if (!MINT_RE.test(ca)) {
        setError("Введи корректный Solana mint / CA.");
        return;
      }

      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setMint(ca);
      setQuery(ca);
      setLoading(true);
      setError(null);
      setWarnings([]);
      setAi(null);
      setChain(null);
      router.replace(`/trade/analysis/social?mint=${encodeURIComponent(ca)}`, {
        scroll: false,
      });

      const xParams = new URLSearchParams({
        mint: ca,
        strategy: "auto",
        scope: "mentions",
        limit: String(options.xLimit),
        excludeSuspicious: String(options.xExcludeSuspicious),
        verifiedOnly: String(options.xVerifiedOnly),
      });
      if (options.symbol) xParams.set("symbol", options.symbol.replace(/^\$/, ""));
      if (options.lookback !== "all") xParams.set("hours", options.lookback);

      const tgParams = new URLSearchParams({
        platform: "telegram",
        limit: String(options.tgLimit),
        min_channel_score: String(options.tgMinChannelScore),
        explicit_calls_only: String(options.tgExplicitCallsOnly),
      });
      if (options.lookback !== "all") tgParams.set("hours", options.lookback);

      const [xResult, tgResult, marketResult, chainResult] =
        await Promise.allSettled([
          json<TwitterStats>(
            `/api/trade/dev-twitter?${xParams.toString()}`,
            controller.signal,
          ),
          json<SocialTimeline>(
            `${BACKEND}/api/v1/social/token/${encodeURIComponent(
              ca,
            )}?${tgParams.toString()}`,
            controller.signal,
          ),
          json<Market>(
            `/api/token-ohlcv?mint=${encodeURIComponent(ca)}`,
            controller.signal,
          ),
          analyzeStream(ca, controller.signal),
        ]);

      if (controller.signal.aborted) return;

      const nextX = xResult.status === "fulfilled" ? xResult.value : null;
      const nextTg = tgResult.status === "fulfilled" ? tgResult.value : null;
      const nextMarket =
        marketResult.status === "fulfilled" ? marketResult.value : null;
      const nextChain =
        chainResult.status === "fulfilled" ? chainResult.value : null;

      setX(nextX);
      setTg(nextTg);
      setMarket(nextMarket);
      setChain(nextChain);

      const nextWarnings: string[] = [];
      if (!nextX) nextWarnings.push("X недоступен");
      if (!nextTg) nextWarnings.push("Telegram недоступен");
      if (!nextMarket) nextWarnings.push("Market недоступен");
      if (!nextChain) nextWarnings.push("Trade history недоступна");
      setWarnings(nextWarnings);

      if (!nextX && !nextTg) {
        setError("Нет данных X и Telegram");
        setLoading(false);
        return;
      }

      const tgItems = (nextTg?.timeline || []).filter(
        (item) => !item.platform || item.platform.toLowerCase() === "telegram",
      );

      if (tgItems.length) {
        try {
          const qwen = await json<AiEnvelope>(
            "/api/trade/social-ai",
            controller.signal,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                mint: ca,
                symbol: nextX?.symbol || options.symbol,
                tokenName: nextMarket?.pair?.name,
                timeline: tgItems,
              }),
            },
          );
          if (!controller.signal.aborted) setAi(qwen);
        } catch (aiError) {
          if (!controller.signal.aborted) {
            const message =
              aiError instanceof Error ? aiError.message : "AI недоступен";
            setWarnings((value) => [...value, `Qwen: ${message}`]);
            setAi({ agent: "qwen", available: false, error: message });
          }
        }
      }

      if (!controller.signal.aborted) setLoading(false);
    },
    [options, router],
  );

  useEffect(() => {
    if (initial && MINT_RE.test(initial)) void run(initial);
    return () => abort.current?.abort();
    // Initial URL mint should trigger exactly once; user refreshes explicitly afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const derived = useMemo(
    () => derive(x, tg, channels, market, chain, ai, options),
    [x, tg, channels, market, chain, ai, options],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(query);
  };

  return (
    <div className="space-y-5" data-tag="trade.social_intelligence.v3">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold text-content">
              Social Intelligence · X + Telegram + Qwen
            </h1>
          </div>
          <p className="mt-1 text-xs text-content-muted">
            Social-метрики, Telegram AI и реальный Price ↔ Social lead/lag по
            on-chain trade timestamps.
          </p>
        </div>
        {mint && (
          <div className="font-mono text-[10px] text-content-faint">
            {mint.slice(0, 8)}…{mint.slice(-7)}
          </div>
        )}
      </header>

      <form
        onSubmit={submit}
        className="surface-panel rounded-2xl border border-bg-border p-4"
      >
        <div className="grid gap-3 lg:grid-cols-[1.5fr_.55fr_.55fr_.45fr]">
          <Field label="Solana mint / CA">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
                placeholder="Вставь contract"
              />
            </div>
          </Field>

          <Field label="Ticker">
            <input
              value={options.symbol}
              onChange={(event) =>
                setOptions((value) => ({ ...value, symbol: event.target.value }))
              }
              className={siteDesign.controls.inputClassName}
              placeholder="BONK"
            />
          </Field>

          <Field label="Период">
            <select
              value={options.lookback}
              onChange={(event) =>
                setOptions((value) => ({
                  ...value,
                  lookback: event.target.value as Lookback,
                }))
              }
              className={siteDesign.controls.inputClassName}
            >
              {[
                ["1", "1 час"],
                ["6", "6 часов"],
                ["24", "24 часа"],
                ["72", "3 дня"],
                ["168", "7 дней"],
                ["720", "30 дней"],
                ["all", "Всё"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex items-end">
            <button
              disabled={loading}
              className={`${siteDesign.controls.primaryActionClassName} w-full`}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Radar className="h-4 w-4" />
              )}
              Анализ
            </button>
          </div>
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-content-muted">
            Фильтры источников
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="X posts">
              <input
                type="number"
                min={10}
                max={100}
                value={options.xLimit}
                onChange={(event) =>
                  setOptions((value) => ({
                    ...value,
                    xLimit: Math.max(
                      10,
                      Math.min(100, num(event.target.value)),
                    ),
                  }))
                }
                className={siteDesign.controls.inputClassName}
              />
            </Field>
            <Field label="TG signals">
              <input
                type="number"
                min={20}
                max={500}
                value={options.tgLimit}
                onChange={(event) =>
                  setOptions((value) => ({
                    ...value,
                    tgLimit: Math.max(
                      20,
                      Math.min(500, num(event.target.value)),
                    ),
                  }))
                }
                className={siteDesign.controls.inputClassName}
              />
            </Field>
            <Field label="Min TG score">
              <input
                type="number"
                min={0}
                max={100}
                value={options.tgMinChannelScore}
                onChange={(event) =>
                  setOptions((value) => ({
                    ...value,
                    tgMinChannelScore: clamp(num(event.target.value)),
                  }))
                }
                className={siteDesign.controls.inputClassName}
              />
            </Field>
            <Check
              label="Verified X only"
              value={options.xVerifiedOnly}
              set={(checked) =>
                setOptions((value) => ({
                  ...value,
                  xVerifiedOnly: checked,
                }))
              }
            />
            <Check
              label="Explicit TG calls"
              value={options.tgExplicitCallsOnly}
              set={(checked) =>
                setOptions((value) => ({
                  ...value,
                  tgExplicitCallsOnly: checked,
                }))
              }
            />
          </div>
        </details>
      </form>

      {error && <Notice tone="danger" text={error} />}
      {warnings.length > 0 && (
        <Notice tone="warning" text={warnings.join(" · ")} />
      )}

      {(x || tg) && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            <Kpi
              label="Social score"
              value={score(derived.socialScore)}
              icon={<Gauge />}
            />
            <Kpi label="X score" value={score(derived.xScore)} icon={<Twitter />} />
            <Kpi label="TG score" value={score(derived.tgScore)} icon={<Send />} />
            <Kpi
              label="Organic"
              value={score(derived.organicScore)}
              icon={<Sparkles />}
            />
            <Kpi
              label="Manipulation"
              value={score(derived.manipulationScore)}
              icon={<ShieldAlert />}
            />
            <Kpi
              label="Early signal"
              value={score(derived.earlySignalScore)}
              icon={<Zap />}
            />
            <Kpi
              label="Alpha"
              value={score(derived.alphaScore)}
              icon={<Radar />}
            />
            <Kpi
              label="AI confidence"
              value={ai?.result ? pct(ai.result.overallConfidence * 100) : "—"}
              icon={<BrainCircuit />}
            />
          </section>

          <PriceSocialPanel price={derived.priceSocial} />

          <section className="surface-panel rounded-2xl border border-bg-border p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-content">
                  Все параметры
                </h2>
                <p className="text-[10px] text-content-faint">
                  Price ↔ Social теперь считается из реальных trades. Параметры
                  без достаточной выборки остаются «—».
                </p>
              </div>
              <button
                type="button"
                onClick={() => void run(mint)}
                disabled={loading}
                className={siteDesign.controls.actionButtonClassName}
              >
                <RefreshCw className="h-4 w-4" />
                Обновить
              </button>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {derived.groups.map((group) => (
                <MetricTable
                  key={group.title}
                  title={group.title}
                  rows={group.rows}
                />
              ))}
            </div>
          </section>

          <AiPanel ai={ai} />
          <TimelinePanel
            x={x}
            tg={tg}
            priceImpulseAt={derived.priceSocial.impulseTime}
            priceImpulseChange={derived.priceSocial.impulseChange}
          />
        </>
      )}
    </div>
  );
}

function derive(
  x: TwitterStats | null,
  tg: SocialTimeline | null,
  channels: Channel[],
  market: Market | null,
  chain: ChainAnalysis | null,
  ai: AiEnvelope | null,
  options: Options,
) {
  const tweets = x?.topTweets || [];
  const telegramItems = (tg?.timeline || []).filter(
    (item) => !item.platform || item.platform.toLowerCase() === "telegram",
  );
  const xTimes = tweets.map((tweet) => ts(tweet.timestamp));
  const tgTimes = telegramItems.map((item) => ts(item.occurred_at));
  const x5 = countSince(xTimes, 5);
  const x15 = countSince(xTimes, 15);
  const x60 = countSince(xTimes, 60);
  const tg5 = countSince(tgTimes, 5);
  const tg15 = countSince(tgTimes, 15);
  const tg60 = countSince(tgTimes, 60);
  const hours = Math.max(1, lookbackHours(options.lookback));

  const xSentiment = sentiment(tweets.map((tweet) => tweet.text));
  const tgSentiment = sentiment(telegramItems.map((item) => item.text));
  const xSentimentChange = sentimentDelta(
    tweets.map((tweet) => ({ time: ts(tweet.timestamp), text: tweet.text })),
  );
  const tgSentimentChange = sentimentDelta(
    telegramItems.map((item) => ({
      time: ts(item.occurred_at),
      text: item.text,
    })),
  );

  const xMentions = x?.totalTweets || 0;
  const tgMentions = tg?.platforms?.telegram || telegramItems.length;
  const xVelocity = xMentions / hours;
  const tgVelocity = tgMentions / hours;
  const xAcceleration = x15
    ? clamp(((x5 / 5) / (x15 / 15)) * 50)
    : 0;
  const tgAcceleration = tg15
    ? clamp(((tg5 / 5) / (tg15 / 15)) * 50)
    : 0;

  const authorRatio = xMentions
    ? clamp(((x?.uniqueMentioners || 0) / xMentions) * 100)
    : 0;
  const verifiedRatio = xMentions
    ? clamp(
        ((x?.aggregated.verifiedAuthors || 0) /
          Math.max(1, x?.uniqueMentioners || 0)) *
          100,
      )
    : 0;

  const botRatio = (x?.aggregated.botRatio || 0) * 100;
  const botRisk = x?.botRiskScore || 0;
  const shillers = x?.shillers || [];
  const reach = shillers.reduce((sum, account) => sum + (account.followers || 0), 0);
  const influencers = shillers.filter(
    (account) =>
      account.isVerified ||
      (account.followers || 0) >= 10_000 ||
      account.totalEngagement >= 5_000,
  );
  const influencerReach = influencers.reduce(
    (sum, account) => sum + (account.followers || 0),
    0,
  );
  const repeatShillers = shillers.filter((account) => account.tweets >= 2).length;
  const smartAccounts = shillers.filter(
    (account) =>
      !account.isBot &&
      (account.isVerified ||
        account.totalEngagement >= 2_500 ||
        (account.followers || 0) >= 5_000),
  ).length;

  const allTexts = [
    ...tweets.map((tweet) => tweet.text),
    ...telegramItems.map((item) => item.text),
  ]
    .map(normalizeText)
    .filter((text) => text.length >= 16);
  const frequency = new Map<string, number>();
  allTexts.forEach((text) => frequency.set(text, (frequency.get(text) || 0) + 1));
  const copied = [...frequency.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  const copyRatio = allTexts.length ? (copied / allTexts.length) * 100 : 0;

  const latestX = tweets.filter((tweet) => {
    const time = ts(tweet.timestamp);
    return time !== null && time >= Date.now() - 3_600_000;
  });
  const botBurst = latestX.length
    ? (latestX.filter((tweet) => tweet.isSuspicious).length / latestX.length) * 100
    : 0;

  const tgKeys = new Set(
    telegramItems.flatMap((item) =>
      [item.source_handle, item.source_name]
        .filter(Boolean)
        .map((value) => String(value).replace(/^@/, "").toLowerCase()),
    ),
  );
  const relevantChannels = channels.filter(
    (channel) =>
      tgKeys.has(String(channel.username || "").replace(/^@/, "").toLowerCase()) ||
      tgKeys.has(String(channel.title || "").toLowerCase()),
  );
  const channelScore = relevantChannels.length
    ? avg(relevantChannels.map((channel) => channel.score))
    : 0;
  const winRate = relevantChannels.length
    ? avg(relevantChannels.map((channel) => channel.win_rate)) * 100
    : 0;
  const rugRate = relevantChannels.length
    ? avg(relevantChannels.map((channel) => channel.rug_rate)) * 100
    : 0;
  const tgChannels = tgKeys.size;
  const explicitCalls = telegramItems.filter(
    (item) =>
      Boolean(item.metrics?.explicit_call || item.metrics?.is_explicit_call) ||
      String(item.event_type || "").includes("call"),
  ).length;

  const aiResult = ai?.result;
  const aiCoordination = aiResult?.coordinationSignals?.length || 0;
  const highRisks =
    aiResult?.risks?.filter(
      (risk) => risk.severity === "high" || risk.severity === "critical",
    ).length || 0;

  const coordinationScore = clamp(
    copyRatio * 0.75 + aiCoordination * 11 + repeatShillers * 3,
  );
  const followerQuality = clamp(
    (100 - botRisk) * 0.45 +
      verifiedRatio * 0.25 +
      clamp(Math.log10(median(shillers.map((account) => account.followers || 0)) + 1) * 18) *
        0.3,
  );
  const paidRisk = clamp(
    coordinationScore * 0.45 +
      botRisk * 0.25 +
      clamp(repeatShillers * 8) * 0.15 +
      highRisks * 8,
  );
  const organicScore = clamp(
    100 - paidRisk * 0.72 - copyRatio * 0.18 + authorRatio * 0.22,
  );

  const xScore = clamp(
    (100 - botRisk) * 0.35 +
      authorRatio * 0.25 +
      clamp(Math.log10((x?.aggregated.totalEngagement || 0) + 1) * 20) * 0.25 +
      followerQuality * 0.15,
  );
  const tgScore = clamp(
    channelScore * 0.3 +
      winRate * 0.2 +
      (100 - rugRate) * 0.2 +
      clamp(tgChannels * 7) * 0.15 +
      clamp(explicitCalls * 8) * 0.15,
  );

  const firstX = Math.min(
    ...xTimes.filter((value): value is number => value !== null),
    Infinity,
  );
  const firstTg = firstTime(telegramItems);
  const crossBoth = Number.isFinite(firstX) && Number.isFinite(firstTg);
  const crossLag = crossBoth ? Math.abs(firstX - firstTg) / 60_000 : Infinity;
  const crossScore = crossBoth
    ? clamp(
        100 -
          Math.min(100, crossLag / 3) +
          Math.min(xVelocity + tgVelocity, 20) * 2,
      )
    : 0;

  const hype = clamp(
    avg([
      xAcceleration,
      tgAcceleration,
      clamp((xVelocity + tgVelocity) * 10),
      clamp((x?.aggregated.engagementRate || 0) * 100),
    ]),
  );
  const fomo = clamp(
    hype * 0.55 +
      Math.max(xSentiment.p, tgSentiment.p) * 0.25 +
      clamp(explicitCalls * 7) * 0.2,
  );
  const manipulationScore = clamp(paidRisk * 0.7 + coordinationScore * 0.3);

  const createdAt = ts(market?.pair?.createdAt);
  const firstSocial = Math.min(firstX, firstTg);
  const earlyMinutes =
    createdAt && Number.isFinite(firstSocial)
      ? Math.max(0, (firstSocial - createdAt) / 60_000)
      : null;
  const earlySignalScore =
    earlyMinutes === null
      ? clamp(70 - Math.min(60, (xMentions + tgMentions) / 10))
      : clamp(100 - earlyMinutes / 12);
  const alphaScore = clamp(
    earlySignalScore * 0.35 +
      organicScore * 0.25 +
      (100 - manipulationScore) * 0.2 +
      crossScore * 0.2,
  );
  const socialScore = clamp(
    xScore * 0.36 + tgScore * 0.34 + organicScore * 0.15 + crossScore * 0.15,
  );

  const firstXAuthor =
    tweets
      .filter((tweet) => ts(tweet.timestamp) !== null)
      .sort((a, b) => num(ts(a.timestamp)) - num(ts(b.timestamp)))[0]?.author || "—";
  const firstTgSource =
    tg?.origin?.source_handle ||
    tg?.origin?.source_name ||
    telegramItems
      .slice()
      .sort((a, b) => num(ts(a.occurred_at)) - num(ts(b.occurred_at)))[0]
      ?.source_handle ||
    "—";

  const narrative = aiResult?.campaignHypothesis?.narrative || "—";
  const campaign = aiResult?.campaignHypothesis?.label || "—";

  const socialEventTimes = [
    ...xTimes.filter((value): value is number => value !== null),
    ...tgTimes.filter((value): value is number => value !== null),
  ];
  const socialSpikeTime = densestWindowTime(socialEventTimes);
  const trades = normalizeTrades(chain);
  const priceImpulse = findPriceImpulseNear(trades, socialSpikeTime);
  const signalPrice =
    socialSpikeTime !== null ? priceAround(trades, socialSpikeTime) : null;
  const price5 =
    socialSpikeTime !== null
      ? priceAtOrAfter(trades, socialSpikeTime + 5 * 60_000)
      : null;
  const price15 =
    socialSpikeTime !== null
      ? priceAtOrAfter(trades, socialSpikeTime + 15 * 60_000)
      : null;
  const price60 =
    socialSpikeTime !== null
      ? priceAtOrAfter(trades, socialSpikeTime + 60 * 60_000)
      : null;

  const reaction5 = changeBetween(signalPrice, price5);
  const reaction15 = changeBetween(signalPrice, price15);
  const reaction60 = changeBetween(signalPrice, price60);

  const oneHourWindow =
    socialSpikeTime === null
      ? []
      : trades.filter(
          (trade) =>
            trade.time >= socialSpikeTime &&
            trade.time <= socialSpikeTime + 60 * 60_000,
        );
  const maxPrice = oneHourWindow.length
    ? Math.max(...oneHourWindow.map((trade) => trade.price))
    : null;
  const minPrice = oneHourWindow.length
    ? Math.min(...oneHourWindow.map((trade) => trade.price))
    : null;
  const maxUpside =
    signalPrice && maxPrice !== null
      ? ((maxPrice - signalPrice.price) / signalPrice.price) * 100
      : null;
  const maxDrawdown =
    signalPrice && minPrice !== null
      ? ((minPrice - signalPrice.price) / signalPrice.price) * 100
      : null;

  const leadLagMinutes =
    socialSpikeTime !== null && priceImpulse
      ? (priceImpulse.time - socialSpikeTime) / 60_000
      : null;
  const leadDirection =
    leadLagMinutes === null
      ? "—"
      : Math.abs(leadLagMinutes) <= 2
        ? "SYNC"
        : leadLagMinutes > 0
          ? "SOCIAL → PRICE"
          : "PRICE → SOCIAL";
  const leadLagConfidence =
    leadLagMinutes === null
      ? null
      : clamp(
          35 +
            Math.min(35, socialEventTimes.length * 1.5) +
            Math.min(30, trades.length / 20),
        );

  const priceSocial = {
    socialSpikeTime,
    signalPrice: signalPrice?.price ?? null,
    reaction5,
    reaction15,
    reaction60,
    maxUpside,
    maxDrawdown,
    impulseTime: priceImpulse?.time ?? null,
    impulseChange: priceImpulse?.change ?? null,
    impulseDirection: priceImpulse?.direction ?? "—",
    leadLagMinutes,
    leadDirection,
    leadLagConfidence,
    tradeCount: trades.length,
    coverageStart: trades[0]?.time ?? null,
    coverageEnd: trades[trades.length - 1]?.time ?? null,
  };

  const groups: Array<{ title: string; rows: Metric[] }> = [
    {
      title: "X / Twitter",
      rows: [
        m("X score", score(xScore), xScore),
        m("Mentions", compact(xMentions)),
        m("Mentions 5m", String(x5), undefined, "sampled top posts"),
        m("Mentions 15m", String(x15), undefined, "sampled top posts"),
        m("Mentions 1h", String(x60), undefined, "sampled top posts"),
        m("Mentions / h", xVelocity.toFixed(2)),
        m("Acceleration", score(xAcceleration), xAcceleration),
        m("Unique authors", compact(x?.uniqueMentioners)),
        m("Author diffusion", pct(authorRatio), authorRatio),
        m("Views", compact(x?.totalViews)),
        m("Likes", compact(x?.totalLikes)),
        m("Reposts", compact(x?.totalRetweets)),
        m("Engagement", compact(x?.aggregated.totalEngagement)),
        m(
          "Engagement rate",
          pct((x?.aggregated.engagementRate || 0) * 100),
        ),
        m("Verified authors", compact(x?.aggregated.verifiedAuthors)),
        m("Verified ratio", pct(verifiedRatio)),
        m("Influencers", String(influencers.length)),
        m("Potential reach", compact(reach)),
        m("Influencer reach", compact(influencerReach)),
        m("Smart accounts", String(smartAccounts)),
        m("Repeat shillers", String(repeatShillers)),
        m("Bot risk", score(botRisk), botRisk),
        m("Bot ratio", pct(botRatio), botRatio),
        m("Bot burst 1h", pct(botBurst), botBurst),
        m("Anomalies", String(x?.anomalyCount || 0)),
        m("Follower quality", score(followerQuality), followerQuality),
        m("Sentiment", xSentiment.label),
        m("Positive", pct(xSentiment.p)),
        m("Neutral", pct(xSentiment.u)),
        m("Negative", pct(xSentiment.n)),
        m("Sentiment change", signedPct(xSentimentChange), xSentimentChange),
        m("First mover", firstXAuthor),
        m("First mention", Number.isFinite(firstX) ? ago(firstX) : "—"),
        m(
          "Earliest discovered account",
          x?.discovery.firstAccountCreatedAt
            ? ago(x.discovery.firstAccountCreatedAt)
            : "—",
        ),
      ],
    },
    {
      title: "Telegram",
      rows: [
        m("TG score", score(tgScore), tgScore),
        m("Mentions", compact(tgMentions)),
        m("Mentions 5m", String(tg5)),
        m("Mentions 15m", String(tg15)),
        m("Mentions 1h", String(tg60)),
        m("Mentions / h", tgVelocity.toFixed(2)),
        m("Acceleration", score(tgAcceleration), tgAcceleration),
        m("Channels", String(tgChannels)),
        m("Explicit calls", String(explicitCalls)),
        m("Channel score", score(channelScore), channelScore),
        m("Historical win rate", pct(winRate)),
        m("Historical rug rate", pct(rugRate), rugRate),
        m("Sentiment", aiResult?.sentiment.label || tgSentiment.label),
        m(
          "AI sentiment score",
          aiResult ? aiResult.sentiment.score.toFixed(2) : "—",
        ),
        m(
          "AI sentiment confidence",
          aiResult ? pct(aiResult.sentiment.confidence * 100) : "—",
        ),
        m("Window sentiment change", signedPct(tgSentimentChange), tgSentimentChange),
        m("Dominant intent", aiResult?.dominantIntent || "—"),
        m("Top/first source", firstTgSource),
        m("First signal", Number.isFinite(firstTg) ? ago(firstTg) : "—"),
        m("AI campaign", campaign),
        m("AI coordination signals", String(aiCoordination)),
        m("AI high risks", String(highRisks)),
        m(
          "AI overall confidence",
          aiResult ? pct(aiResult.overallConfidence * 100) : "—",
        ),
      ],
    },
    {
      title: "Growth / Quality / Manipulation",
      rows: [
        m("Hype score", score(hype), hype),
        m("FOMO score", score(fomo), fomo),
        m("Organic score", score(organicScore), organicScore),
        m("Paid promotion risk", score(paidRisk), paidRisk),
        m("Manipulation score", score(manipulationScore), manipulationScore),
        m("Coordination score", score(coordinationScore), coordinationScore),
        m("Copy-paste ratio", pct(copyRatio), copyRatio),
        m("Coordinated AI signals", String(aiCoordination)),
        m("Follower quality", score(followerQuality), followerQuality),
        m(
          "Narrative strength",
          score(
            clamp(
              hype * 0.45 +
                crossScore * 0.25 +
                (aiResult?.campaignHypothesis.confidence || 0) * 30,
            ),
          ),
        ),
        m("Narrative", narrative),
        m("Campaign hypothesis", campaign),
        m("Peak velocity", `${Math.max(xVelocity, tgVelocity).toFixed(2)}/h`),
        m(
          "Velocity change",
          score(avg([xAcceleration, tgAcceleration])),
        ),
        m(
          "Sentiment change",
          signedPct(
            avg(
              [xSentimentChange, tgSentimentChange].filter(
                (value): value is number => value !== null,
              ),
            ),
          ),
          undefined,
          "positive-share change inside selected window",
        ),
      ],
    },
    {
      title: "Cross-platform / Timing",
      rows: [
        m("Cross-platform score", score(crossScore), crossScore),
        m("Both platforms active", crossBoth ? "YES" : "NO"),
        m(
          "TG → X lag",
          crossBoth && firstTg <= firstX ? safeLag(firstTg, firstX) : "—",
        ),
        m(
          "X → TG lag",
          crossBoth && firstX < firstTg ? safeLag(firstX, firstTg) : "—",
        ),
        m("First X", Number.isFinite(firstX) ? ago(firstX) : "—"),
        m("First TG", Number.isFinite(firstTg) ? ago(firstTg) : "—"),
        m(
          "Social spike",
          socialSpikeTime === null ? "—" : ago(socialSpikeTime),
          undefined,
          "densest 5-minute cross-platform window",
        ),
        m("Early signal score", score(earlySignalScore), earlySignalScore),
        m("Alpha score", score(alphaScore), alphaScore),
        m("Social score", score(socialScore), socialScore),
        m("Price ↔ Social direction", leadDirection),
        m(
          "Lead / lag",
          leadLagMinutes === null
            ? "—"
            : `${Math.abs(leadLagMinutes).toFixed(1)}m`,
          leadLagMinutes,
          leadDirection === "SOCIAL → PRICE"
            ? "social leads"
            : leadDirection === "PRICE → SOCIAL"
              ? "price leads"
              : leadDirection === "SYNC"
                ? "within ±2m"
                : undefined,
        ),
        m("Lead/lag confidence", score(leadLagConfidence), leadLagConfidence),
        m("Price after social 5m", signedPct(reaction5), reaction5),
        m("Price after social 15m", signedPct(reaction15), reaction15),
        m("Price after social 1h", signedPct(reaction60), reaction60),
        m("Max upside 1h", signedPct(maxUpside), maxUpside),
        m("Max drawdown 1h", signedPct(maxDrawdown), maxDrawdown),
        m(
          "Nearest 5m price impulse",
          priceImpulse
            ? `${priceImpulse.direction} ${signedPct(priceImpulse.change)}`
            : "—",
        ),
        m("Price 1h snapshot", market?.pair?.changeH1 == null ? "—" : signedPct(market.pair.changeH1)),
        m("Price 24h snapshot", market?.pair?.change24h == null ? "—" : signedPct(market.pair.change24h)),
        m("Volume 1h", money(market?.pair?.volumeH1)),
        m("Volume 24h", money(market?.pair?.volumeH24)),
        m("Liquidity", money(market?.pair?.liquidityUsd)),
      ],
    },
    {
      title: "Price event evidence",
      rows: [
        m("Trades sampled", compact(trades.length)),
        m(
          "Trade history start",
          trades.length ? ago(trades[0].time) : "—",
        ),
        m(
          "Trade history end",
          trades.length ? ago(trades[trades.length - 1].time) : "—",
        ),
        m(
          "Price at social spike",
          signalPrice ? signalPrice.price.toPrecision(6) : "—",
          undefined,
          "SOL price from analyze-stream",
        ),
        m(
          "Price +5m",
          price5 ? price5.price.toPrecision(6) : "—",
          undefined,
          "first trade at/after target",
        ),
        m(
          "Price +15m",
          price15 ? price15.price.toPrecision(6) : "—",
        ),
        m(
          "Price +1h",
          price60 ? price60.price.toPrecision(6) : "—",
        ),
        m(
          "Impulse timestamp",
          priceImpulse ? ago(priceImpulse.time) : "—",
        ),
        m(
          "Impulse threshold",
          `${PRICE_IMPULSE_THRESHOLD_PCT}% / ${PRICE_IMPULSE_WINDOW_MS / 60_000}m`,
          undefined,
          "nearest qualifying impulse within ±6h of social spike",
        ),
        m(
          "On-chain raw trades",
          compact(chain?.summary?.totalRawTrades || chain?.summary?.totalTrades),
        ),
        m("Unique wallets", compact(chain?.summary?.uniqueWallets)),
        m(
          "History truncated",
          chain?.truncated === undefined ? "—" : chain.truncated ? "YES" : "NO",
        ),
      ],
    },
    {
      title: "AI Agent / Evidence",
      rows: [
        m(
          "Agent",
          ai?.available
            ? `${ai.provider || "qwen"} · ${ai.model || "Qwen"}`
            : "unavailable",
        ),
        m("AI latency", ai?.latencyMs ? `${Math.round(ai.latencyMs)} ms` : "—"),
        m("AI cache", ai?.cache || "—"),
        m("Summary", aiResult?.summary || "—"),
        m("Claims", String(aiResult?.claims?.length || 0)),
        m("Entities", String(aiResult?.entities?.length || 0)),
        m("Relationships", String(aiResult?.relationships?.length || 0)),
        m("Risks", String(aiResult?.risks?.length || 0)),
        m(
          "Originators",
          aiResult?.campaignHypothesis.likelyOriginators.join(", ") || "—",
        ),
        m(
          "Amplifiers",
          aiResult?.campaignHypothesis.amplifiers.slice(0, 6).join(", ") || "—",
        ),
      ],
    },
  ];

  return {
    groups,
    xScore,
    tgScore,
    organicScore,
    manipulationScore,
    earlySignalScore,
    alphaScore,
    socialScore,
    priceSocial,
  };
}

const m = (
  label: string,
  value: string,
  raw?: number | null,
  note?: string,
): Metric => ({ label, value, raw, note });

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

function Check({
  label,
  value,
  set,
}: {
  label: string;
  value: boolean;
  set: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center gap-2 rounded-xl border border-bg-border bg-bg-card px-3 text-xs text-content-muted">
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => set(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Notice({
  tone,
  text,
}: {
  tone: "danger" | "warning";
  text: string;
}) {
  return (
    <div
      className={`flex gap-2 rounded-xl border p-3 text-xs ${
        tone === "danger"
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-warning/30 bg-warning/10 text-content-muted"
      }`}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {text}
    </div>
  );
}

function Kpi({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: ReactNode;
}) {
  return (
    <div className="surface-panel rounded-xl border border-bg-border p-3">
      <div className="flex items-center justify-between text-content-faint">
        <span className="text-[9px] uppercase tracking-wider">{label}</span>
        <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      </div>
      <div className="mt-2 font-mono text-lg font-bold text-content">{value}</div>
    </div>
  );
}

function MetricTable({
  title,
  rows,
}: {
  title: string;
  rows: Metric[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-bg-border">
      <div className="border-b border-bg-border bg-bg-elevated/60 px-3 py-2 text-xs font-semibold text-content">
        {title}
      </div>
      <div className="divide-y divide-bg-border">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[minmax(0,1fr)_minmax(90px,.8fr)] gap-3 px-3 py-2 text-[11px]"
          >
            <div>
              <div className="text-content-muted">{row.label}</div>
              {row.note && (
                <div className="mt-0.5 text-[9px] text-content-faint">
                  {row.note}
                </div>
              )}
            </div>
            <div className="break-words text-right font-mono font-semibold text-content">
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PriceSocialPanel({
  price,
}: {
  price: {
    socialSpikeTime: number | null;
    signalPrice: number | null;
    reaction5: number | null;
    reaction15: number | null;
    reaction60: number | null;
    maxUpside: number | null;
    maxDrawdown: number | null;
    impulseTime: number | null;
    impulseChange: number | null;
    impulseDirection: string;
    leadLagMinutes: number | null;
    leadDirection: string;
    leadLagConfidence: number | null;
    tradeCount: number;
    coverageStart: number | null;
    coverageEnd: number | null;
  };
}) {
  return (
    <section className="surface-panel rounded-2xl border border-bg-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <div>
          <h2 className="text-sm font-semibold text-content">
            Price ↔ Social lead/lag
          </h2>
          <p className="text-[10px] text-content-faint">
            Social spike сравнивается с ближайшим движением цены ≥{" "}
            {PRICE_IMPULSE_THRESHOLD_PCT}% за 5 минут.
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Direction" value={price.leadDirection} icon={<Zap />} />
        <Kpi
          label="Lead / lag"
          value={
            price.leadLagMinutes === null
              ? "—"
              : `${Math.abs(price.leadLagMinutes).toFixed(1)}m`
          }
          icon={<Gauge />}
        />
        <Kpi
          label="Confidence"
          value={score(price.leadLagConfidence)}
          icon={<Radar />}
        />
        <Kpi
          label="+5m"
          value={signedPct(price.reaction5)}
          icon={<TrendingUp />}
        />
        <Kpi
          label="+15m"
          value={signedPct(price.reaction15)}
          icon={<TrendingUp />}
        />
        <Kpi
          label="+1h"
          value={signedPct(price.reaction60)}
          icon={<TrendingUp />}
        />
        <Kpi
          label="Max up 1h"
          value={signedPct(price.maxUpside)}
          icon={<TrendingUp />}
        />
        <Kpi
          label="Max DD 1h"
          value={signedPct(price.maxDrawdown)}
          icon={<ShieldAlert />}
        />
      </div>
    </section>
  );
}

function AiPanel({ ai }: { ai: AiEnvelope | null }) {
  const result = ai?.result;
  return (
    <section className="surface-panel rounded-2xl border border-bg-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <BrainCircuit className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-content">
          Qwen AI · Telegram second-stage analysis
        </h2>
      </div>
      {!ai ? (
        <div className="text-xs text-content-faint">
          AI запускается после получения Telegram сообщений.
        </div>
      ) : !result ? (
        <div className="text-xs text-warning">
          Qwen недоступен: {ai.error || "нет результата"}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
          <div>
            <p className="text-sm leading-6 text-content-soft">{result.summary}</p>
            <div className="mt-3 rounded-xl border border-bg-border bg-bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-content-faint">
                Campaign narrative
              </div>
              <div className="mt-1 text-xs leading-5 text-content-muted">
                {result.campaignHypothesis.narrative || "—"}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {result.reasoningSummary.map((value, index) => (
              <div
                key={index}
                className="rounded-lg border border-bg-border bg-bg-elevated/50 px-3 py-2 text-xs text-content-muted"
              >
                {value}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TimelinePanel({
  x,
  tg,
  priceImpulseAt,
  priceImpulseChange,
}: {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  priceImpulseAt: number | null;
  priceImpulseChange: number | null;
}) {
  const items = useMemo(() => {
    const rows: TimelineItem[] = [...(tg?.timeline || [])];
    for (const tweet of x?.topTweets || []) {
      rows.push({
        platform: "x",
        source_handle: tweet.author,
        source_name: null,
        source_url: null,
        text: tweet.text,
        occurred_at: tweet.timestamp ? new Date(tweet.timestamp).toISOString() : "",
        metrics: {
          likes: tweet.likes,
          retweets: tweet.retweets,
          views: tweet.views,
        },
      });
    }
    if (priceImpulseAt !== null) {
      rows.push({
        platform: "price",
        source_handle: "on-chain",
        source_name: "price impulse",
        source_url: null,
        text: `Nearest ${PRICE_IMPULSE_WINDOW_MS / 60_000}m impulse: ${signedPct(
          priceImpulseChange,
        )}`,
        occurred_at: new Date(priceImpulseAt).toISOString(),
        metrics: null,
      });
    }
    return rows
      .sort((a, b) => num(ts(a.occurred_at)) - num(ts(b.occurred_at)))
      .slice(0, 100);
  }, [x, tg, priceImpulseAt, priceImpulseChange]);

  return (
    <section className="surface-panel rounded-2xl border border-bg-border p-4">
      <h2 className="text-sm font-semibold text-content">
        Signal timeline · TG → X → Price → Hype
      </h2>
      <div className="mt-3 space-y-2">
        {items.length ? (
          items.map((item, index) => (
            <div
              key={`${index}-${item.platform}-${item.source_handle}`}
              className="grid grid-cols-[70px_120px_1fr] gap-2 rounded-xl border border-bg-border bg-bg-card/50 p-2 text-[10px]"
            >
              <div className="font-mono text-content-faint">
                {item.occurred_at
                  ? new Date(item.occurred_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </div>
              <div className="font-semibold text-content">
                {item.platform.toUpperCase()} ·{" "}
                {item.source_handle || item.source_name || "source"}
              </div>
              <div className="line-clamp-2 text-content-muted">{item.text}</div>
            </div>
          ))
        ) : (
          <div className="text-xs text-content-faint">
            Нет timestamped сигналов.
          </div>
        )}
      </div>
    </section>
  );
}
