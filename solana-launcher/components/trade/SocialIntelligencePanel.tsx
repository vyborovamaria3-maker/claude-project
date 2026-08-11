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
const IMPULSE_WINDOW_MS = 5 * 60_000;
const IMPULSE_THRESHOLD_PCT = 10;
const HOUR_MS = 60 * 60_000;

type Lookback = "1" | "6" | "24" | "72" | "168" | "720" | "all";
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
  totalTweets: number;
  totalViews: number;
  totalLikes: number;
  totalRetweets: number;
  uniqueMentioners: number;
  botRiskScore: number;
  anomalyCount: number;
  topTweets: Tweet[];
  shillers: Shiller[];
  aggregated: {
    totalEngagement: number;
    engagementRate: number;
    verifiedAuthors: number;
    botRatio: number;
  };
};

type SocialTimeline = {
  mentions: number;
  platforms: Record<string, number>;
  origin: TimelineItem | null;
  timeline: TimelineItem[];
};

type Channel = {
  username: string | null;
  title: string;
  score: number;
  win_rate: number;
  rug_rate: number;
};

type Market = {
  pair?: {
    name?: string;
    createdAt?: number | null;
    changeH1?: number | null;
    change24h?: number | null;
    volumeH1?: number | null;
    volumeH24?: number | null;
    liquidityUsd?: number | null;
  };
};

type ChainTrade = { ts: number; p: number };
type ChainAnalysis = {
  trades?: ChainTrade[];
  truncated?: boolean;
  summary?: {
    totalRawTrades?: number;
    totalTrades?: number;
    uniqueWallets?: number;
  };
};

type AiResult = {
  summary?: string;
  dominantIntent?: string;
  sentiment?: { label?: string; score?: number; confidence?: number };
  coordinationSignals?: Array<{ severity?: string }>;
  risks?: Array<{ severity?: string }>;
  claims?: unknown[];
  entities?: unknown[];
  relationships?: unknown[];
  reasoningSummary?: string[];
  overallConfidence?: number;
  campaignHypothesis?: {
    label?: string;
    confidence?: number;
    narrative?: string;
    likelyOriginators?: string[];
    amplifiers?: string[];
  };
};

type AiEnvelope = {
  agent?: string;
  available?: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  cache?: string;
  error?: string;
  result?: AiResult;
};

type Metric = { label: string; value: string; note?: string };
type TradePoint = { time: number; price: number };
type PriceSocial = {
  socialSpikeTime: number | null;
  reaction5: number | null;
  reaction15: number | null;
  reaction60: number | null;
  maxUpside: number | null;
  maxDrawdown: number | null;
  impulseTime: number | null;
  impulseChange: number | null;
  leadLagMinutes: number | null;
  leadDirection: string;
  leadLagConfidence: number | null;
  tradeCount: number;
};

type Derived = {
  groups: Array<{ title: string; rows: Metric[] }>;
  xScore: number;
  tgScore: number;
  organic: number;
  manipulation: number;
  socialRisk: number;
  early: number;
  alpha: number;
  socialScore: number;
  price: PriceSocial;
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

const numberOr = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const compact = (value: unknown) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(numberOr(value));
const pct = (value: unknown) =>
  Number.isFinite(Number(value)) ? `${numberOr(value).toFixed(1)}%` : "—";
const signedPct = (value: unknown) =>
  Number.isFinite(Number(value))
    ? `${numberOr(value) >= 0 ? "+" : ""}${numberOr(value).toFixed(1)}%`
    : "—";
const score = (value: unknown) =>
  Number.isFinite(Number(value)) ? `${Math.round(numberOr(value))}/100` : "—";
const money = (value: unknown) =>
  Number.isFinite(Number(value)) ? `$${compact(value)}` : "—";
const normalizeRatePct = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.abs(parsed) <= 1 ? parsed * 100 : parsed);
};
const toTimestamp = (value: unknown) => {
  if (value == null || value === "") return null;
  let parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1e12) parsed *= 1000;
  return parsed;
};
const ago = (value: unknown, now = Date.now()) => {
  const timestamp = toTimestamp(value);
  if (timestamp == null) return "—";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  return minutes < 60
    ? `${minutes}m`
    : minutes < 2880
      ? `${Math.round(minutes / 60)}h`
      : `${Math.round(minutes / 1440)}d`;
};
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 220);
const growthPct = (current: number, previous: number) =>
  previous > 0 ? ((current - previous) / previous) * 100 : null;
const metric = (label: string, value: string, note?: string): Metric => ({ label, value, note });
const warningKey = (message: string) => message.split(":", 1)[0];
const upsertWarning = (warnings: string[], message: string) => {
  const key = warningKey(message);
  return [...warnings.filter((item) => warningKey(item) !== key), message];
};

function sentiment(texts: string[]) {
  const positive = /\b(bull|bullish|buy|gem|moon|pump|breakout|alpha|early|strong|ape|send|upside|good|great|лонг|покуп|ракета|рост|гем)\b|🚀|🔥|📈|💎/i;
  const negative = /\b(rug|scam|dump|sell|exit|dead|avoid|warning|bear|rekt|скам|раг|слив|продаж|паден)\b|⚠|📉|☠/i;
  let pos = 0;
  let neg = 0;
  let neutral = 0;
  for (const text of texts) {
    const isPositive = positive.test(text);
    const isNegative = negative.test(text);
    if (isPositive && !isNegative) pos += 1;
    else if (isNegative && !isPositive) neg += 1;
    else neutral += 1;
  }
  const total = pos + neg + neutral;
  if (!total) return { label: "—", p: 0, n: 0, u: 0 };
  return {
    label: pos / total > 0.52 ? "BULLISH" : neg / total > 0.38 ? "BEARISH" : "MIXED",
    p: (pos / total) * 100,
    n: (neg / total) * 100,
    u: (neutral / total) * 100,
  };
}

function sentimentDelta(rows: Array<{ time: number | null; text: string }>) {
  const sorted = rows
    .filter((row): row is { time: number; text: string } => row.time != null)
    .sort((a, b) => a.time - b.time);
  if (sorted.length < 4) return null;
  const middle = Math.floor(sorted.length / 2);
  return sentiment(sorted.slice(middle).map((row) => row.text)).p -
    sentiment(sorted.slice(0, middle).map((row) => row.text)).p;
}

function windowStats<T>(
  rows: T[],
  timeOf: (row: T) => number | null,
  keyOf: (row: T) => unknown,
  now: number,
) {
  const counts = { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 };
  const unique6 = new Set<string>();
  const uniquePrev6 = new Set<string>();
  const unique24 = new Set<string>();
  for (const row of rows) {
    const time = timeOf(row);
    if (time == null) continue;
    const age = now - time;
    if (age < 0) continue;
    if (age <= 5 * 60_000) counts.m5 += 1;
    if (age <= 15 * 60_000) counts.m15 += 1;
    if (age <= HOUR_MS) counts.h1 += 1;
    if (age <= 6 * HOUR_MS) counts.h6 += 1;
    if (age <= 24 * HOUR_MS) counts.h24 += 1;
    const key = keyOf(row);
    if (!key) continue;
    const normalized = String(key).toLowerCase();
    if (age <= 6 * HOUR_MS) unique6.add(normalized);
    else if (age <= 12 * HOUR_MS) uniquePrev6.add(normalized);
    if (age <= 24 * HOUR_MS) unique24.add(normalized);
  }
  return {
    ...counts,
    unique6: unique6.size,
    uniquePrev6: uniquePrev6.size,
    unique24: unique24.size,
  };
}

function densestWindowTime(times: number[], windowMs = 5 * 60_000) {
  const sorted = [...times].sort((a, b) => a - b);
  if (!sorted.length) return null;
  let bestStart = 0;
  let bestEnd = 0;
  let end = 0;
  for (let start = 0; start < sorted.length; start += 1) {
    if (end < start) end = start;
    while (end + 1 < sorted.length && sorted[end + 1] - sorted[start] <= windowMs) end += 1;
    if (end - start > bestEnd - bestStart) {
      bestStart = start;
      bestEnd = end;
    }
  }
  return sorted[Math.floor((bestStart + bestEnd) / 2)];
}

function lowerBound(trades: TradePoint[], target: number) {
  let low = 0;
  let high = trades.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (trades[middle].time < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function priceAtOrBefore(trades: TradePoint[], target: number, toleranceMs: number) {
  const index = lowerBound(trades, target);
  const candidate = index < trades.length && trades[index].time === target ? trades[index] : trades[index - 1];
  return candidate && target - candidate.time <= toleranceMs ? candidate : null;
}

function priceAtOrAfter(trades: TradePoint[], target: number, toleranceMs: number) {
  const index = lowerBound(trades, target);
  const candidate = trades[index];
  return candidate && candidate.time - target <= toleranceMs ? candidate : null;
}

function priceNear(trades: TradePoint[], target: number, toleranceMs: number) {
  const index = lowerBound(trades, target);
  const before = trades[index - 1];
  const after = trades[index];
  const candidate = !before
    ? after
    : !after
      ? before
      : target - before.time <= after.time - target
        ? before
        : after;
  return candidate && Math.abs(candidate.time - target) <= toleranceMs ? candidate : null;
}

function priceChange(a: TradePoint | null, b: TradePoint | null) {
  return a && b && a.price > 0 ? ((b.price - a.price) / a.price) * 100 : null;
}

function findPriceImpulse(trades: TradePoint[], socialTime: number | null) {
  let best: { time: number; change: number } | null = null;
  for (const trade of trades) {
    if (socialTime != null && Math.abs(trade.time - socialTime) > 6 * HOUR_MS) continue;
    const base = priceAtOrBefore(trades, trade.time - IMPULSE_WINDOW_MS, IMPULSE_WINDOW_MS);
    if (!base || base.price <= 0) continue;
    const change = ((trade.price - base.price) / base.price) * 100;
    if (Math.abs(change) < IMPULSE_THRESHOLD_PCT) continue;
    if (!best || socialTime == null || Math.abs(trade.time - socialTime) < Math.abs(best.time - socialTime)) {
      best = { time: trade.time, change };
    }
  }
  return best;
}

async function fetchJson<T>(url: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal, ...init });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorData = data as { detail?: string; error?: string };
    throw new Error(errorData.detail || errorData.error || `HTTP ${response.status}`);
  }
  return data as T;
}

async function readChainStream(mint: string, signal: AbortSignal): Promise<ChainAnalysis | null> {
  const response = await fetch(`/api/trade/analyze-stream?mint=${encodeURIComponent(mint)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`analyze-stream HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload: ChainAnalysis | null = null;

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: { type?: string; message?: string } & Partial<ChainAnalysis>;
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    if (event.type === "error") throw new Error(event.message || "on-chain analysis failed");
    if (event.type === "final") {
      const { type: _type, message: _message, ...payload } = event;
      finalPayload = payload as ChainAnalysis;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
    return finalPayload;
  } finally {
    reader.releaseLock();
  }
}

export default function SocialIntelligencePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMintRef = useRef(params.get("mint")?.trim() || "");
  const initialMint = initialMintRef.current;

  const [query, setQuery] = useState(initialMint);
  const [mint, setMint] = useState(initialMint);
  const [options, setOptions] = useState<Options>(DEFAULT);
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
      setAi(null);
      setChain(null);
      router.replace(`/trade/analysis/social?mint=${encodeURIComponent(contract)}`, { scroll: false });

      const xParams = new URLSearchParams({
        mint: contract,
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

      void readChainStream(contract, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setChain(value);
        })
        .catch((chainError: unknown) => {
          if (!controller.signal.aborted) {
            const message = chainError instanceof Error ? chainError.message : "недоступна";
            setWarnings((value) => upsertWarning(value, `Trade history: ${message}`));
          }
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

      const sourceWarnings: string[] = [];
      if (!nextX) sourceWarnings.push("X: недоступен");
      if (!nextTg) sourceWarnings.push("Telegram: недоступен");
      if (!nextMarket) sourceWarnings.push("Market: недоступен");
      setWarnings((value) => {
        let nextWarnings = value;
        for (const message of sourceWarnings) nextWarnings = upsertWarning(nextWarnings, message);
        return nextWarnings;
      });

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
    // Run only for the initial URL mint; later runs are explicit user actions.
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
    <div className="space-y-5" data-tag="trade.social_intelligence.v5">
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

function deriveSocialMetrics(
  x: TwitterStats | null,
  tg: SocialTimeline | null,
  market: Market | null,
  chain: ChainAnalysis | null,
  ai: AiEnvelope | null,
  channels: Channel[],
  options: Options,
): Derived {
  const now = Date.now();
  const tweets = x?.topTweets || [];
  const telegramItems = (tg?.timeline || []).filter((item) => !item.platform || item.platform.toLowerCase() === "telegram");
  const xTimes = tweets.map((tweet) => toTimestamp(tweet.timestamp));
  const tgTimes = telegramItems.map((item) => toTimestamp(item.occurred_at));
  const lookbackHours = Math.max(1, options.lookback === "all" ? 720 : Number(options.lookback));
  const xMentions = x?.totalTweets || 0;
  const tgMentions = tg?.platforms?.telegram ?? telegramItems.length;
  const xVelocity = xMentions / lookbackHours;
  const tgVelocity = tgMentions / lookbackHours;
  const xWindow = windowStats(tweets, (tweet) => toTimestamp(tweet.timestamp), (tweet) => tweet.author, now);
  const tgWindow = windowStats(telegramItems, (item) => toTimestamp(item.occurred_at), (item) => item.source_handle || item.source_name, now);
  const xAcceleration = xWindow.m15 ? clamp((xWindow.m5 / 5) / (xWindow.m15 / 15) * 50) : 0;
  const tgAcceleration = tgWindow.m15 ? clamp((tgWindow.m5 / 5) / (tgWindow.m15 / 15) * 50) : 0;

  const xSentiment = sentiment(tweets.map((tweet) => tweet.text));
  const tgSentiment = sentiment(telegramItems.map((item) => item.text));
  const xSentimentDelta = sentimentDelta(tweets.map((tweet) => ({ time: toTimestamp(tweet.timestamp), text: tweet.text })));
  const tgSentimentDelta = sentimentDelta(telegramItems.map((item) => ({ time: toTimestamp(item.occurred_at), text: item.text })));
  const authorRatio = xMentions ? clamp((x?.uniqueMentioners || 0) / xMentions * 100) : 0;
  const verifiedRatio = x?.uniqueMentioners ? clamp((x.aggregated.verifiedAuthors || 0) / x.uniqueMentioners * 100) : 0;
  const botRatio = normalizeRatePct(x?.aggregated.botRatio) ?? 0;
  const botRisk = clamp(x?.botRiskScore || 0);
  const shillers = x?.shillers || [];
  const reach = shillers.reduce((sum, account) => sum + (account.followers || 0), 0);
  const influencers = shillers.filter((account) => account.isVerified || (account.followers || 0) >= 10_000 || account.totalEngagement >= 5_000);
  const influencerReach = influencers.reduce((sum, account) => sum + (account.followers || 0), 0);
  const repeatShillers = shillers.filter((account) => account.tweets >= 2).length;
  const smartAccounts = shillers.filter((account) => !account.isBot && (account.isVerified || account.totalEngagement >= 2_500 || (account.followers || 0) >= 5_000)).length;

  const normalizedTexts = [...tweets.map((tweet) => tweet.text), ...telegramItems.map((item) => item.text)]
    .map(normalizeText)
    .filter((text) => text.length >= 16);
  const frequencies = new Map<string, number>();
  for (const text of normalizedTexts) frequencies.set(text, (frequencies.get(text) || 0) + 1);
  const copied = [...frequencies.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  const copyRatio = normalizedTexts.length ? copied / normalizedTexts.length * 100 : 0;
  const recentXTweets = tweets.filter((tweet) => {
    const time = toTimestamp(tweet.timestamp);
    return time != null && time >= now - HOUR_MS;
  });
  const botBurst = recentXTweets.length ? recentXTweets.filter((tweet) => tweet.isSuspicious).length / recentXTweets.length * 100 : 0;

  const tgKeys = new Set(
    telegramItems.flatMap((item) => [item.source_handle, item.source_name].filter(Boolean).map((value) => String(value).replace(/^@/, "").toLowerCase())),
  );
  const relatedChannels = channels.filter((channel) =>
    tgKeys.has(String(channel.username || "").replace(/^@/, "").toLowerCase()) || tgKeys.has(channel.title.toLowerCase()),
  );
  const channelScore = relatedChannels.length ? average(relatedChannels.map((channel) => clamp(numberOr(channel.score)))) : 0;
  const winRates = relatedChannels.map((channel) => normalizeRatePct(channel.win_rate)).filter((value): value is number => value != null);
  const rugRates = relatedChannels.map((channel) => normalizeRatePct(channel.rug_rate)).filter((value): value is number => value != null);
  const winRate = average(winRates);
  const rugRate = average(rugRates);
  const explicitCalls = telegramItems.filter((item) => Boolean(item.metrics?.explicit_call || item.metrics?.is_explicit_call) || String(item.event_type || "").toLowerCase().includes("call")).length;

  const aiResult = ai?.result;
  const aiCoordination = aiResult?.coordinationSignals?.length || 0;
  const highAiRisks = aiResult?.risks?.filter((risk) => risk.severity === "high" || risk.severity === "critical").length || 0;
  const coordinationScore = clamp(copyRatio * 0.75 + aiCoordination * 11 + repeatShillers * 3);
  const followerQuality = clamp((100 - botRisk) * 0.45 + verifiedRatio * 0.25 + clamp(Math.log10(median(shillers.map((account) => account.followers || 0)) + 1) * 18) * 0.3);
  const paidPromotionRisk = clamp(coordinationScore * 0.45 + botRisk * 0.25 + clamp(repeatShillers * 8) * 0.15 + highAiRisks * 8);
  const organic = clamp(100 - paidPromotionRisk * 0.72 - copyRatio * 0.18 + authorRatio * 0.22);
  const xScore = clamp((100 - botRisk) * 0.35 + authorRatio * 0.25 + clamp(Math.log10((x?.aggregated.totalEngagement || 0) + 1) * 20) * 0.25 + followerQuality * 0.15);
  const tgScore = clamp(channelScore * 0.3 + winRate * 0.2 + (100 - rugRate) * 0.2 + clamp(tgKeys.size * 7) * 0.15 + clamp(explicitCalls * 8) * 0.15);

  const finiteXTimes = xTimes.filter((value): value is number => value != null);
  const finiteTgTimes = tgTimes.filter((value): value is number => value != null);
  const firstXTime = finiteXTimes.length ? Math.min(...finiteXTimes) : null;
  const firstTgTime = finiteTgTimes.length ? Math.min(...finiteTgTimes) : null;
  const bothPlatforms = firstXTime != null && firstTgTime != null;
  const crossLagMinutes = bothPlatforms ? Math.abs(firstXTime - firstTgTime) / 60_000 : null;
  const crossScore = bothPlatforms
    ? clamp(100 - Math.min(100, (crossLagMinutes || 0) / 3) + Math.min(xVelocity + tgVelocity, 20) * 2)
    : 0;
  const hype = clamp(average([xAcceleration, tgAcceleration, clamp((xVelocity + tgVelocity) * 10), clamp((x?.aggregated.engagementRate || 0) * 100)]));
  const fomo = clamp(hype * 0.55 + Math.max(xSentiment.p, tgSentiment.p) * 0.25 + clamp(explicitCalls * 7) * 0.2);
  const manipulation = clamp(paidPromotionRisk * 0.7 + coordinationScore * 0.3);
  const socialRisk = clamp(manipulation * 0.4 + botRisk * 0.24 + rugRate * 0.14 + (100 - organic) * 0.12 + Math.min(100, highAiRisks * 18) * 0.1);
  const riskLevel = socialRisk >= 70 ? "HIGH" : socialRisk >= 40 ? "MEDIUM" : "LOW";

  const createdAt = toTimestamp(market?.pair?.createdAt);
  const firstSocial = firstXTime == null ? firstTgTime : firstTgTime == null ? firstXTime : Math.min(firstXTime, firstTgTime);
  const earlyMinutes = createdAt != null && firstSocial != null ? Math.max(0, (firstSocial - createdAt) / 60_000) : null;
  const early = earlyMinutes == null ? clamp(70 - Math.min(60, (xMentions + tgMentions) / 10)) : clamp(100 - earlyMinutes / 12);
  const alpha = clamp(early * 0.35 + organic * 0.25 + (100 - manipulation) * 0.2 + crossScore * 0.2);
  const socialScore = clamp(xScore * 0.36 + tgScore * 0.34 + organic * 0.15 + crossScore * 0.15);

  const socialEventTimes = [...finiteXTimes, ...finiteTgTimes];
  const socialSpikeTime = densestWindowTime(socialEventTimes);
  const trades: TradePoint[] = (chain?.trades || [])
    .map((trade) => ({ time: toTimestamp(trade.ts), price: Number(trade.p) }))
    .filter((trade): trade is { time: number; price: number } => trade.time != null && Number.isFinite(trade.price) && trade.price > 0)
    .sort((a, b) => a.time - b.time);
  const priceImpulse = findPriceImpulse(trades, socialSpikeTime);
  const priceAtSpike = socialSpikeTime == null ? null : priceNear(trades, socialSpikeTime, 5 * 60_000);
  const price5 = socialSpikeTime == null ? null : priceAtOrAfter(trades, socialSpikeTime + 5 * 60_000, 5 * 60_000);
  const price15 = socialSpikeTime == null ? null : priceAtOrAfter(trades, socialSpikeTime + 15 * 60_000, 5 * 60_000);
  const price60 = socialSpikeTime == null ? null : priceAtOrAfter(trades, socialSpikeTime + HOUR_MS, 10 * 60_000);
  const reaction5 = priceChange(priceAtSpike, price5);
  const reaction15 = priceChange(priceAtSpike, price15);
  const reaction60 = priceChange(priceAtSpike, price60);
  const oneHourTrades = socialSpikeTime == null ? [] : trades.filter((trade) => trade.time >= socialSpikeTime && trade.time <= socialSpikeTime + HOUR_MS);
  const maxPrice = oneHourTrades.length ? Math.max(...oneHourTrades.map((trade) => trade.price)) : null;
  const minPrice = oneHourTrades.length ? Math.min(...oneHourTrades.map((trade) => trade.price)) : null;
  const maxUpside = priceAtSpike && maxPrice != null ? (maxPrice - priceAtSpike.price) / priceAtSpike.price * 100 : null;
  const maxDrawdown = priceAtSpike && minPrice != null ? (minPrice - priceAtSpike.price) / priceAtSpike.price * 100 : null;
  const leadLagMinutes = socialSpikeTime != null && priceImpulse ? (priceImpulse.time - socialSpikeTime) / 60_000 : null;
  const leadDirection = leadLagMinutes == null ? "—" : Math.abs(leadLagMinutes) <= 2 ? "SYNC" : leadLagMinutes > 0 ? "SOCIAL → PRICE" : "PRICE → SOCIAL";
  const leadLagConfidence = leadLagMinutes == null ? null : clamp(35 + Math.min(35, socialEventTimes.length * 1.5) + Math.min(30, trades.length / 20));
  const price: PriceSocial = {
    socialSpikeTime,
    reaction5,
    reaction15,
    reaction60,
    maxUpside,
    maxDrawdown,
    impulseTime: priceImpulse?.time ?? null,
    impulseChange: priceImpulse?.change ?? null,
    leadLagMinutes,
    leadDirection,
    leadLagConfidence,
    tradeCount: trades.length,
  };

  const firstXAuthor = [...tweets]
    .filter((tweet) => toTimestamp(tweet.timestamp) != null)
    .sort((a, b) => numberOr(toTimestamp(a.timestamp)) - numberOr(toTimestamp(b.timestamp)))[0]?.author || "—";
  const firstTgSource = tg?.origin?.source_handle || tg?.origin?.source_name || [...telegramItems]
    .sort((a, b) => numberOr(toTimestamp(a.occurred_at)) - numberOr(toTimestamp(b.occurred_at)))[0]?.source_handle || "—";
  const sentimentChanges = [xSentimentDelta, tgSentimentDelta].filter((value): value is number => value != null);
  const combinedSentimentDelta = sentimentChanges.length ? average(sentimentChanges) : null;
  const narrative = aiResult?.campaignHypothesis?.narrative || "—";
  const campaign = aiResult?.campaignHypothesis?.label || "—";

  const groups: Derived["groups"] = [
    { title: "X / Twitter", rows: [
      metric("X score", score(xScore)), metric("Mentions", compact(xMentions)), metric("Mentions 5m", String(xWindow.m5), "sampled top posts"), metric("Mentions 15m", String(xWindow.m15), "sampled top posts"), metric("Mentions 1h", String(xWindow.h1), "sampled top posts"), metric("Mentions 6h", String(xWindow.h6), "sampled top posts"), metric("Mentions 24h", String(xWindow.h24), "sampled top posts"), metric("Mentions / h", xVelocity.toFixed(2)), metric("Acceleration", score(xAcceleration)), metric("Unique authors", compact(x?.uniqueMentioners)), metric("Unique authors 6h", String(xWindow.unique6), "sampled top posts"), metric("Unique authors 24h", String(xWindow.unique24), "sampled top posts"), metric("Author growth 6h", signedPct(growthPct(xWindow.unique6, xWindow.uniquePrev6)), "vs previous 6h"), metric("Author diffusion", pct(authorRatio)), metric("Views", compact(x?.totalViews)), metric("Likes", compact(x?.totalLikes)), metric("Reposts", compact(x?.totalRetweets)), metric("Engagement", compact(x?.aggregated.totalEngagement)), metric("Engagement rate", pct((x?.aggregated.engagementRate || 0) * 100)), metric("Verified authors", compact(x?.aggregated.verifiedAuthors)), metric("Verified ratio", pct(verifiedRatio)), metric("Influencers", String(influencers.length)), metric("Potential reach", compact(reach)), metric("Influencer reach", compact(influencerReach)), metric("Smart accounts", String(smartAccounts)), metric("Repeat shillers", String(repeatShillers)), metric("Bot risk", score(botRisk)), metric("Bot ratio", pct(botRatio)), metric("Bot burst 1h", pct(botBurst)), metric("Anomalies", String(x?.anomalyCount || 0)), metric("Follower quality", score(followerQuality)), metric("Sentiment", xSentiment.label), metric("Positive", pct(xSentiment.p)), metric("Neutral", pct(xSentiment.u)), metric("Negative", pct(xSentiment.n)), metric("Sentiment change", signedPct(xSentimentDelta)), metric("First mover", firstXAuthor), metric("First mention", firstXTime != null ? ago(firstXTime, now) : "—"), metric("Account age", "—", "X collector does not expose account creation date"),
    ]},
    { title: "Telegram", rows: [
      metric("TG score", score(tgScore)), metric("Mentions", compact(tgMentions)), metric("Mentions 5m", String(tgWindow.m5)), metric("Mentions 15m", String(tgWindow.m15)), metric("Mentions 1h", String(tgWindow.h1)), metric("Mentions 6h", String(tgWindow.h6)), metric("Mentions 24h", String(tgWindow.h24)), metric("Mentions / h", tgVelocity.toFixed(2)), metric("Acceleration", score(tgAcceleration)), metric("Channels", String(tgKeys.size)), metric("Channels 6h", String(tgWindow.unique6)), metric("Channels 24h", String(tgWindow.unique24)), metric("Channel growth 6h", signedPct(growthPct(tgWindow.unique6, tgWindow.uniquePrev6)), "vs previous 6h"), metric("Explicit calls", String(explicitCalls)), metric("Channel score", score(channelScore)), metric("Historical win rate", pct(winRate)), metric("Historical rug rate", pct(rugRate)), metric("Sentiment", aiResult?.sentiment?.label || tgSentiment.label), metric("AI sentiment score", aiResult?.sentiment?.score != null ? numberOr(aiResult.sentiment.score).toFixed(2) : "—"), metric("AI sentiment confidence", aiResult?.sentiment?.confidence != null ? pct(numberOr(aiResult.sentiment.confidence) * 100) : "—"), metric("Window sentiment change", signedPct(tgSentimentDelta)), metric("Dominant intent", aiResult?.dominantIntent || "—"), metric("Top/first source", firstTgSource), metric("First signal", firstTgTime != null ? ago(firstTgTime, now) : "—"), metric("AI campaign", campaign), metric("AI coordination signals", String(aiCoordination)), metric("AI high risks", String(highAiRisks)), metric("AI overall confidence", aiResult?.overallConfidence != null ? pct(numberOr(aiResult.overallConfidence) * 100) : "—"),
    ]},
    { title: "Growth / Quality / Manipulation", rows: [
      metric("Hype score", score(hype)), metric("FOMO score", score(fomo)), metric("Organic score", score(organic)), metric("Paid promotion risk", score(paidPromotionRisk)), metric("Manipulation score", score(manipulation)), metric("Social risk", score(socialRisk)), metric("Social risk level", riskLevel), metric("Coordination score", score(coordinationScore)), metric("Copy-paste ratio", pct(copyRatio)), metric("Follower quality", score(followerQuality)), metric("Narrative strength", score(clamp(hype * 0.45 + crossScore * 0.25 + numberOr(aiResult?.campaignHypothesis?.confidence) * 30))), metric("Narrative", narrative), metric("Campaign hypothesis", campaign), metric("Peak velocity", `${Math.max(xVelocity, tgVelocity).toFixed(2)}/h`), metric("Velocity change", score(average([xAcceleration, tgAcceleration]))), metric("Sentiment change", signedPct(combinedSentimentDelta), "positive-share change inside window"),
    ]},
    { title: "Cross-platform / Timing", rows: [
      metric("Cross-platform score", score(crossScore)), metric("Both platforms active", bothPlatforms ? "YES" : "NO"), metric("TG → X lag", bothPlatforms && firstTgTime <= firstXTime ? `${Math.round((firstXTime - firstTgTime) / 60_000)}m` : "—"), metric("X → TG lag", bothPlatforms && firstXTime < firstTgTime ? `${Math.round((firstTgTime - firstXTime) / 60_000)}m` : "—"), metric("First X", firstXTime != null ? ago(firstXTime, now) : "—"), metric("First TG", firstTgTime != null ? ago(firstTgTime, now) : "—"), metric("Social spike", socialSpikeTime == null ? "—" : ago(socialSpikeTime, now), "densest 5m window"), metric("Early signal score", score(early)), metric("Alpha score", score(alpha)), metric("Social score", score(socialScore)), metric("Price ↔ Social direction", leadDirection), metric("Lead / lag", leadLagMinutes == null ? "—" : `${Math.abs(leadLagMinutes).toFixed(1)}m`), metric("Lead/lag confidence", score(leadLagConfidence)), metric("Price after social 5m", signedPct(reaction5)), metric("Price after social 15m", signedPct(reaction15)), metric("Price after social 1h", signedPct(reaction60)), metric("Max upside 1h", signedPct(maxUpside)), metric("Max drawdown 1h", signedPct(maxDrawdown)), metric("Nearest 5m price impulse", priceImpulse ? signedPct(priceImpulse.change) : "—"), metric("Price 1h snapshot", signedPct(market?.pair?.changeH1)), metric("Price 24h snapshot", signedPct(market?.pair?.change24h)), metric("Volume 1h", money(market?.pair?.volumeH1)), metric("Volume 24h", money(market?.pair?.volumeH24)), metric("Liquidity", money(market?.pair?.liquidityUsd)),
    ]},
    { title: "Price event evidence", rows: [
      metric("Trades sampled", compact(trades.length)), metric("Trade history start", trades.length ? ago(trades[0].time, now) : "—"), metric("Trade history end", trades.length ? ago(trades[trades.length - 1].time, now) : "—"), metric("Price at social spike", priceAtSpike ? priceAtSpike.price.toPrecision(6) : "—", "SOL price"), metric("Price +5m", price5 ? price5.price.toPrecision(6) : "—", "first trade at/after target within 5m"), metric("Price +15m", price15 ? price15.price.toPrecision(6) : "—", "first trade at/after target within 5m"), metric("Price +1h", price60 ? price60.price.toPrecision(6) : "—", "first trade at/after target within 10m"), metric("Impulse timestamp", priceImpulse ? ago(priceImpulse.time, now) : "—"), metric("Impulse threshold", `${IMPULSE_THRESHOLD_PCT}% / ${IMPULSE_WINDOW_MS / 60_000}m`), metric("On-chain raw trades", compact(chain?.summary?.totalRawTrades ?? chain?.summary?.totalTrades)), metric("Unique wallets", compact(chain?.summary?.uniqueWallets)), metric("History truncated", chain?.truncated == null ? "—" : chain.truncated ? "YES" : "NO"),
    ]},
    { title: "AI Agent / Evidence", rows: [
      metric("Agent", ai?.available ? `${ai.provider || "qwen"} · ${ai.model || "Qwen"}` : "unavailable"), metric("AI latency", ai?.latencyMs != null ? `${Math.round(ai.latencyMs)} ms` : "—"), metric("AI cache", ai?.cache || "—"), metric("Summary", aiResult?.summary || "—"), metric("Claims", String(aiResult?.claims?.length || 0)), metric("Entities", String(aiResult?.entities?.length || 0)), metric("Relationships", String(aiResult?.relationships?.length || 0)), metric("Risks", String(aiResult?.risks?.length || 0)), metric("Originators", aiResult?.campaignHypothesis?.likelyOriginators?.join(", ") || "—"), metric("Amplifiers", aiResult?.campaignHypothesis?.amplifiers?.slice(0, 6).join(", ") || "—"),
    ]},
  ];

  return { groups, xScore, tgScore, organic, manipulation, socialRisk, early, alpha, socialScore, price };
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
