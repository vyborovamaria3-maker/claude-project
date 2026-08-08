"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  Clock3,
  ExternalLink,
  Gauge,
  Loader2,
  MessageCircle,
  Network,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Twitter,
  Users,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import { siteDesign } from "@/lib/siteDesign";

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_CACHE_TTL = 2 * 60 * 1000;
const PARAMS_STORAGE_KEY = "potapoff.social-analysis.params.v1";

type XStrategy = "auto" | "nitter" | "playwright";
type XScope = "mentions" | "official";
type Lookback = "1" | "6" | "24" | "72" | "168" | "720" | "all";

interface AnalysisOptions {
  symbol: string;
  twitterHandle: string;
  lookback: Lookback;
  xStrategy: XStrategy;
  xScope: XScope;
  xLimit: number;
  xMinEngagement: number;
  xVerifiedOnly: boolean;
  xExcludeSuspicious: boolean;
  tgSources: string;
  tgLimit: number;
  tgMinEngagement: number;
  tgMinChannelScore: number;
  tgExplicitCallsOnly: boolean;
}

const DEFAULT_OPTIONS: AnalysisOptions = {
  symbol: "",
  twitterHandle: "",
  lookback: "24",
  xStrategy: "auto",
  xScope: "mentions",
  xLimit: 20,
  xMinEngagement: 0,
  xVerifiedOnly: false,
  xExcludeSuspicious: true,
  tgSources: "",
  tgLimit: 100,
  tgMinEngagement: 0,
  tgMinChannelScore: 0,
  tgExplicitCallsOnly: false,
};

interface TweetRow {
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  views: number;
  timestamp: number | null;
  isSuspicious: boolean;
}

interface ShillerRow {
  handle: string;
  tweets: number;
  totalEngagement: number;
  isBot: boolean;
  followers: number | null;
  postsCount: number | null;
  isVerified: boolean;
}

interface TwitterStats {
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
  topTweets: TweetRow[];
  shillers: ShillerRow[];
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
}

interface TimelineItem {
  rank?: number;
  platform: "telegram" | "x" | string;
  event_type?: string;
  source_handle: string | null;
  source_name: string | null;
  source_url: string | null;
  text: string;
  occurred_at: string;
  metrics: Record<string, unknown> | null;
}

interface SocialTimeline {
  mint_address: string;
  mentions: number;
  platforms: Record<string, number>;
  origin: TimelineItem | null;
  timeline: TimelineItem[];
}

interface ChannelRow {
  id: number;
  username: string | null;
  title: string;
  entity_type: string;
  participants: number;
  score: number;
  calls_count: number;
  win_rate: number;
  rug_rate: number;
  avg_roi: number;
}

interface CallerRow {
  username: string;
  calls: number;
  wins: number;
  win_rate: number;
  rug_rate: number;
  avg_roi: number;
  score: number;
}

interface SocialBundle {
  twitter: TwitterStats | null;
  timeline: SocialTimeline | null;
  fetchedAt: number;
  warnings: string[];
}

const socialCache = new Map<string, SocialBundle>();

function compact(value: number | null | undefined): string {
  const safe = Number.isFinite(value) ? Number(value) : 0;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(safe);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value > 0.1 ? 0 : 1)}%`;
}

function shortMint(value: string): string {
  if (value.length < 14) return value;
  return `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function relativeTime(value: string | number | null | undefined): string {
  if (!value) return "—";
  const ts = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(ts)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function lookbackLabel(value: Lookback): string {
  const labels: Record<Lookback, string> = {
    "1": "1 час",
    "6": "6 часов",
    "24": "24 часа",
    "72": "3 дня",
    "168": "7 дней",
    "720": "30 дней",
    all: "Всё время",
  };
  return labels[value];
}

function normalizeOptions(value: Partial<AnalysisOptions>): AnalysisOptions {
  const lookbackValues: Lookback[] = ["1", "6", "24", "72", "168", "720", "all"];
  const strategyValues: XStrategy[] = ["auto", "nitter", "playwright"];
  const scopeValues: XScope[] = ["mentions", "official"];
  const lookback = lookbackValues.includes(value.lookback as Lookback) ? value.lookback as Lookback : DEFAULT_OPTIONS.lookback;
  const xStrategy = strategyValues.includes(value.xStrategy as XStrategy) ? value.xStrategy as XStrategy : DEFAULT_OPTIONS.xStrategy;
  const xScope = scopeValues.includes(value.xScope as XScope) ? value.xScope as XScope : DEFAULT_OPTIONS.xScope;

  return {
    ...DEFAULT_OPTIONS,
    symbol: String(value.symbol ?? DEFAULT_OPTIONS.symbol),
    twitterHandle: String(value.twitterHandle ?? DEFAULT_OPTIONS.twitterHandle),
    tgSources: String(value.tgSources ?? DEFAULT_OPTIONS.tgSources),
    lookback,
    xStrategy,
    xScope,
    xLimit: Math.max(5, Math.min(100, Number(value.xLimit ?? DEFAULT_OPTIONS.xLimit) || DEFAULT_OPTIONS.xLimit)),
    xMinEngagement: Math.max(0, Number(value.xMinEngagement ?? DEFAULT_OPTIONS.xMinEngagement) || 0),
    xVerifiedOnly: typeof value.xVerifiedOnly === "boolean" ? value.xVerifiedOnly : DEFAULT_OPTIONS.xVerifiedOnly,
    xExcludeSuspicious: typeof value.xExcludeSuspicious === "boolean" ? value.xExcludeSuspicious : DEFAULT_OPTIONS.xExcludeSuspicious,
    tgLimit: Math.max(1, Math.min(1000, Number(value.tgLimit ?? DEFAULT_OPTIONS.tgLimit) || DEFAULT_OPTIONS.tgLimit)),
    tgMinEngagement: Math.max(0, Number(value.tgMinEngagement ?? DEFAULT_OPTIONS.tgMinEngagement) || 0),
    tgMinChannelScore: Math.max(0, Math.min(100, Number(value.tgMinChannelScore ?? DEFAULT_OPTIONS.tgMinChannelScore) || 0)),
    tgExplicitCallsOnly: typeof value.tgExplicitCallsOnly === "boolean" ? value.tgExplicitCallsOnly : DEFAULT_OPTIONS.tgExplicitCallsOnly,
  };
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
  }
  return payload as T;
}

export default function SocialIntelligencePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMint = params.get("mint")?.trim() || "";
  const [query, setQuery] = useState(initialMint);
  const [mint, setMint] = useState(initialMint);
  const [options, setOptions] = useState<AnalysisOptions>(DEFAULT_OPTIONS);
  const [optionsReady, setOptionsReady] = useState(false);
  const [twitter, setTwitter] = useState<TwitterStats | null>(null);
  const [timeline, setTimeline] = useState<SocialTimeline | null>(null);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [callers, setCallers] = useState<CallerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [deepLoading, setDeepLoading] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<"all" | "x" | "telegram">("all");
  const abortRef = useRef<AbortController | null>(null);
  const didInitialLoad = useRef(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PARAMS_STORAGE_KEY);
      if (saved) setOptions(normalizeOptions(JSON.parse(saved) as Partial<AnalysisOptions>));
    } catch {
      window.localStorage.removeItem(PARAMS_STORAGE_KEY);
    } finally {
      setOptionsReady(true);
    }
  }, []);

  useEffect(() => {
    if (!optionsReady) return;
    window.localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(options));
  }, [options, optionsReady]);

  useEffect(() => {
    let cancelled = false;
    const loadOverview = async () => {
      setOverviewLoading(true);
      const [channelResult, callerResult] = await Promise.allSettled([
        getJson<{ items: ChannelRow[] }>(`${BACKEND}/api/v1/telegram/channels?limit=8`),
        getJson<{ items: CallerRow[] }>(`${BACKEND}/api/v1/telegram/top-callers?limit=8`),
      ]);
      if (cancelled) return;
      if (channelResult.status === "fulfilled") setChannels(channelResult.value.items || []);
      if (callerResult.status === "fulfilled") setCallers(callerResult.value.items || []);
      setOverviewLoading(false);
    };
    void loadOverview();
    return () => {
      cancelled = true;
    };
  }, []);

  const runAnalysis = useCallback(async (nextMint: string, deep = false) => {
    const clean = nextMint.trim();
    setQuery(clean);
    if (!SOLANA_MINT_RE.test(clean)) {
      setError("Введи корректный Solana mint / CA (Base58, 32–44 символа).");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setMint(clean);
    setError(null);
    setWarnings([]);
    if (deep) setDeepLoading(true);
    else setLoading(true);
    router.replace(`/trade/analysis/social?mint=${encodeURIComponent(clean)}`, { scroll: false });

    try {
      const cacheKey = `${clean}:${deep ? "deep" : "normal"}:${JSON.stringify(options)}`;
      const cached = socialCache.get(cacheKey);
      if (!deep && cached && Date.now() - cached.fetchedAt < CLIENT_CACHE_TTL) {
        setTwitter(cached.twitter);
        setTimeline(cached.timeline);
        setWarnings(cached.warnings);
        return;
      }

      const xParams = new URLSearchParams({
        mint: clean,
        strategy: deep ? "playwright" : options.xStrategy,
        scope: options.xScope,
        limit: String(options.xLimit),
        minEngagement: String(options.xMinEngagement),
        verifiedOnly: String(options.xVerifiedOnly),
        excludeSuspicious: String(options.xExcludeSuspicious),
      });
      if (options.symbol.trim()) xParams.set("symbol", options.symbol.trim().replace(/^\$/, ""));
      if (options.twitterHandle.trim()) xParams.set("twitter", options.twitterHandle.trim());
      if (options.lookback !== "all") xParams.set("hours", options.lookback);

      const tgParams = new URLSearchParams({
        platform: "telegram",
        limit: String(options.tgLimit),
        min_engagement: String(options.tgMinEngagement),
        min_channel_score: String(options.tgMinChannelScore),
        explicit_calls_only: String(options.tgExplicitCallsOnly),
      });
      if (options.lookback !== "all") tgParams.set("hours", options.lookback);
      if (options.tgSources.trim()) tgParams.set("sources", options.tgSources.trim());

      const [xResult, timelineResult] = await Promise.allSettled([
        getJson<TwitterStats>(`/api/trade/dev-twitter?${xParams.toString()}`, controller.signal),
        getJson<SocialTimeline>(`${BACKEND}/api/v1/social/token/${encodeURIComponent(clean)}?${tgParams.toString()}`, controller.signal),
      ]);

      if (controller.signal.aborted) return;

      const nextWarnings: string[] = [];
      const nextTwitter = xResult.status === "fulfilled" ? xResult.value : null;
      const nextTimeline = timelineResult.status === "fulfilled" ? timelineResult.value : null;

      if (xResult.status === "rejected") nextWarnings.push(`X: ${xResult.reason instanceof Error ? xResult.reason.message : "нет данных"}`);
      if (timelineResult.status === "rejected") nextWarnings.push(`TG: ${timelineResult.reason instanceof Error ? timelineResult.reason.message : "нет данных"}`);
      if (!nextTwitter && !nextTimeline) {
        throw new Error(nextWarnings.join(" · ") || "Не удалось получить Social Intelligence данные");
      }

      setTwitter(nextTwitter);
      setTimeline(nextTimeline);
      setWarnings(nextWarnings);
      socialCache.set(cacheKey, {
        twitter: nextTwitter,
        timeline: nextTimeline,
        fetchedAt: Date.now(),
        warnings: nextWarnings,
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Ошибка Social Intelligence");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setDeepLoading(false);
      }
    }
  }, [options, router]);

  useEffect(() => {
    if (!optionsReady || didInitialLoad.current || !initialMint || !SOLANA_MINT_RE.test(initialMint)) return;
    didInitialLoad.current = true;
    void runAnalysis(initialMint);
  }, [initialMint, optionsReady, runAnalysis]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const mergedTimeline = useMemo(() => {
    const items: TimelineItem[] = [...(timeline?.timeline || [])];
    for (const tweet of twitter?.topTweets || []) {
      items.push({
        platform: "x",
        source_handle: tweet.author,
        source_name: null,
        source_url: `https://x.com/${tweet.author}`,
        text: tweet.text,
        occurred_at: tweet.timestamp == null ? "" : new Date(tweet.timestamp).toISOString(),
        metrics: {
          likes: tweet.likes,
          retweets: tweet.retweets,
          views: tweet.views,
          suspicious: tweet.isSuspicious,
        },
      });
    }

    const seen = new Set<string>();
    return items
      .filter((item) => {
        const key = `${item.platform}|${item.source_handle || item.source_name || ""}|${item.text.slice(0, 120)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return sourceFilter === "all" || item.platform === sourceFilter;
      })
      .sort((a, b) => {
        const bTime = Date.parse(b.occurred_at);
        const aTime = Date.parse(a.occurred_at);
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      })
      .slice(0, 80);
  }, [timeline, twitter, sourceFilter]);

  const telegramMentions = timeline?.platforms?.telegram || 0;
  const xMentions = twitter?.totalTweets || 0;
  const totalSignals = xMentions + telegramMentions;
  const busy = loading || deepLoading;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runAnalysis(query);
  };

  return (
    <div className="space-y-5" data-tag="trade.social_intelligence">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--theme-secondary)_34%,transparent)] bg-[color-mix(in_srgb,var(--theme-secondary)_12%,transparent)]">
            <Network className="h-5 w-5 text-[color:var(--theme-secondary)]" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold text-content">Trade · Social Intelligence</h1>
              <span className="rounded-full border border-bg-border bg-bg-elevated/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-muted">X + Telegram</span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-content-muted">
              Перед анализом можно ограничить период, качество X-сигналов и Telegram-источники. Параметры сохраняются в браузере.
            </p>
          </div>
        </div>
        {twitter && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-content-faint">
            <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">{twitter.collectionStrategy} · {twitter.performance.cached ? "cache" : `${twitter.performance.responseTimeMs} ms`}</span>
            <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">период {lookbackLabel(options.lookback)}</span>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="surface-panel rounded-2xl border border-bg-border p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            <div>
              <h2 className="text-sm font-semibold text-content">Параметры анализа</h2>
              <p className="mt-0.5 text-[10px] text-content-faint">Token · X / Twitter · Telegram</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOptions(DEFAULT_OPTIONS)}
            disabled={busy}
            className="rounded-lg border border-bg-border bg-bg-card px-2.5 py-1.5 text-[10px] font-semibold text-content-muted transition hover:text-content"
          >
            Сбросить параметры
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.5fr_0.55fr_0.65fr]">
          <ParameterField label="Solana mint / CA" hint="обязательно">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Вставь mint / CA"
                autoComplete="off"
                spellCheck={false}
                className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
                aria-label="Solana mint address"
              />
            </div>
          </ParameterField>
          <ParameterField label="Ticker" hint="необязательно">
            <input
              value={options.symbol}
              onChange={(event) => setOptions((prev) => ({ ...prev, symbol: event.target.value }))}
              placeholder="BONK"
              className={siteDesign.controls.inputClassName}
            />
          </ParameterField>
          <ParameterField label="Период" hint="X + TG">
            <select
              value={options.lookback}
              onChange={(event) => setOptions((prev) => ({ ...prev, lookback: event.target.value as Lookback }))}
              className={siteDesign.controls.inputClassName}
            >
              <option value="1">1 час</option>
              <option value="6">6 часов</option>
              <option value="24">24 часа</option>
              <option value="72">3 дня</option>
              <option value="168">7 дней</option>
              <option value="720">30 дней</option>
              <option value="all">Всё время</option>
            </select>
          </ParameterField>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <section className="rounded-2xl border border-bg-border bg-bg-card/55 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Twitter className="h-4 w-4" />
              <div>
                <h3 className="text-xs font-semibold text-content">X / Twitter</h3>
                <p className="text-[10px] text-content-faint">Бесплатный сбор через Nitter / активную browser-session.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ParameterField label="X handle" hint="@ или URL">
                <input
                  value={options.twitterHandle}
                  onChange={(event) => setOptions((prev) => ({ ...prev, twitterHandle: event.target.value }))}
                  placeholder="@project"
                  className={siteDesign.controls.inputClassName}
                />
              </ParameterField>
              <ParameterField label="Strategy">
                <select
                  value={options.xStrategy}
                  onChange={(event) => setOptions((prev) => ({ ...prev, xStrategy: event.target.value as XStrategy }))}
                  className={siteDesign.controls.inputClassName}
                >
                  <option value="auto">Auto</option>
                  <option value="nitter">Nitter</option>
                  <option value="playwright">Playwright session</option>
                </select>
              </ParameterField>
              <ParameterField label="Scope">
                <select
                  value={options.xScope}
                  onChange={(event) => setOptions((prev) => ({ ...prev, xScope: event.target.value as XScope }))}
                  className={siteDesign.controls.inputClassName}
                >
                  <option value="mentions">Все mentions</option>
                  <option value="official">Только official account</option>
                </select>
              </ParameterField>
              <ParameterField label="Макс. постов">
                <select
                  value={options.xLimit}
                  onChange={(event) => setOptions((prev) => ({ ...prev, xLimit: Number(event.target.value) }))}
                  className={siteDesign.controls.inputClassName}
                >
                  {[10, 20, 40, 80].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </ParameterField>
              <ParameterField label="Min engagement" hint="likes + reposts + replies">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={options.xMinEngagement}
                  onChange={(event) => setOptions((prev) => ({ ...prev, xMinEngagement: Math.max(0, Number(event.target.value) || 0) }))}
                  className={siteDesign.controls.inputClassName}
                />
              </ParameterField>
              <div className="space-y-2 pt-0 sm:pt-5">
                <ToggleRow
                  label="Только verified"
                  checked={options.xVerifiedOnly}
                  onChange={(checked) => setOptions((prev) => ({ ...prev, xVerifiedOnly: checked }))}
                />
                <ToggleRow
                  label="Убирать bots / suspicious"
                  checked={options.xExcludeSuspicious}
                  onChange={(checked) => setOptions((prev) => ({ ...prev, xExcludeSuspicious: checked }))}
                />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-bg-border bg-bg-card/55 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Send className="h-4 w-4 text-[color:var(--theme-secondary)]" />
              <div>
                <h3 className="text-xs font-semibold text-content">Telegram</h3>
                <p className="text-[10px] text-content-faint">Фильтрация сохранённой MTProto-истории каналов и чатов.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ParameterField label="Каналы" hint="через запятую">
                <input
                  value={options.tgSources}
                  onChange={(event) => setOptions((prev) => ({ ...prev, tgSources: event.target.value }))}
                  placeholder="channel1, channel2"
                  className={siteDesign.controls.inputClassName}
                />
              </ParameterField>
              <ParameterField label="Макс. сигналов">
                <select
                  value={options.tgLimit}
                  onChange={(event) => setOptions((prev) => ({ ...prev, tgLimit: Number(event.target.value) }))}
                  className={siteDesign.controls.inputClassName}
                >
                  {[20, 50, 100, 200, 500].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </ParameterField>
              <ParameterField label="Min channel score">
                <select
                  value={options.tgMinChannelScore}
                  onChange={(event) => setOptions((prev) => ({ ...prev, tgMinChannelScore: Number(event.target.value) }))}
                  className={siteDesign.controls.inputClassName}
                >
                  <option value={0}>Любой</option>
                  <option value={25}>25+</option>
                  <option value={50}>50+</option>
                  <option value={75}>75+</option>
                </select>
              </ParameterField>
              <ParameterField label="Min engagement" hint="reactions + forwards + replies">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={options.tgMinEngagement}
                  onChange={(event) => setOptions((prev) => ({ ...prev, tgMinEngagement: Math.max(0, Number(event.target.value) || 0) }))}
                  className={siteDesign.controls.inputClassName}
                />
              </ParameterField>
              <div className="sm:col-span-2 space-y-2 pt-0 sm:pt-5">
                <ToggleRow
                  label="Только explicit calls / gem / alpha / buy-сигналы"
                  checked={options.tgExplicitCallsOnly}
                  onChange={(checked) => setOptions((prev) => ({ ...prev, tgExplicitCallsOnly: checked }))}
                />
              </div>
            </div>
          </section>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-bg-border pt-4">
          <button type="submit" disabled={busy || !optionsReady} className={siteDesign.controls.primaryActionClassName}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            Анализировать X + Telegram
          </button>
          {mint && (
            <button type="button" onClick={() => void runAnalysis(mint)} disabled={busy} className={siteDesign.controls.actionButtonClassName}>
              <RefreshCw className={clsx("h-4 w-4", loading && "animate-spin")} />
              Обновить
            </button>
          )}
          {mint && (
            <button type="button" onClick={() => void runAnalysis(mint, true)} disabled={busy} className={siteDesign.controls.actionButtonClassName} title="Принудительно использовать активную X browser-session">
              {deepLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Deep X
            </button>
          )}
          <div className="ml-auto text-[10px] text-content-faint">Период: {lookbackLabel(options.lookback)} · TG score ≥ {options.tgMinChannelScore} · X engagement ≥ {options.xMinEngagement}</div>
        </div>
      </form>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-content-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div>
            <div className="font-semibold text-danger">Social Intelligence недоступен</div>
            <div className="mt-1 text-xs text-content-muted">{error}</div>
          </div>
        </div>
      )}

      {warnings.length > 0 && !error && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-xs text-content-muted">
          <AlertTriangle className="h-4 w-4 text-warning" />
          Показаны частичные данные: {warnings.join(" · ")}
        </div>
      )}

      {busy && !twitter && !timeline ? (
        <SocialSkeleton />
      ) : mint && (twitter || timeline) ? (
        <>
          <section className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
            <div className="flex flex-col gap-4 border-b border-bg-border p-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="text-2xl font-bold tracking-tight text-content">{twitter?.symbol ? `$${twitter.symbol}` : options.symbol ? `$${options.symbol}` : "Token"}</h2>
                  <span className="font-mono text-xs text-content-faint">{shortMint(mint)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-content-muted">
                  {twitter?.twitterHandle ? (
                    <a href={`https://x.com/${twitter.twitterHandle}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5 transition hover:border-primary-border hover:text-content">
                      <Twitter className="h-3.5 w-3.5" />@{twitter.twitterHandle}<ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5">официальный X не определён</span>
                  )}
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5"><Send className="h-3.5 w-3.5" /> Telegram signals: {telegramMentions}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[480px]">
                <MiniMetric label="Signals" value={compact(totalSignals)} icon={<Zap className="h-3.5 w-3.5" />} />
                <MiniMetric label="Authors" value={compact(twitter?.uniqueMentioners || 0)} icon={<Users className="h-3.5 w-3.5" />} />
                <MiniMetric label="Engagement" value={compact(twitter?.aggregated.totalEngagement || 0)} icon={<MessageCircle className="h-3.5 w-3.5" />} />
                <MiniMetric label="Bot risk" value={twitter ? `${twitter.botRiskScore}/100` : "—"} icon={<ShieldAlert className="h-3.5 w-3.5" />} tone={twitter?.botRisk === "high" ? "danger" : twitter?.botRisk === "medium" ? "warning" : "default"} />
              </div>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="X mentions" value={compact(xMentions)} detail={`${compact(twitter?.totalViews || 0)} views · ${compact(twitter?.totalLikes || 0)} likes`} icon={<Twitter className="h-4 w-4" />} />
              <MetricCard label="Telegram" value={compact(telegramMentions)} detail={timeline?.origin ? `first filtered signal ${relativeTime(timeline.origin.occurred_at)} ago` : "no TG signals after filters"} icon={<Send className="h-4 w-4" />} />
              <MetricCard label="Bot / anomalies" value={compact(twitter?.anomalyCount || 0)} detail={twitter ? `${percent(twitter.aggregated.botRatio)} suspicious posts` : "—"} icon={<Bot className="h-4 w-4" />} />
              <MetricCard label="Engagement rate" value={twitter ? percent(twitter.aggregated.engagementRate) : "—"} detail={twitter ? `${twitter.aggregated.verifiedAuthors} verified authors` : "—"} icon={<Gauge className="h-4 w-4" />} />
            </div>
          </section>

          {twitter && twitter.shillers.length > 0 && (
            <section className="surface-panel rounded-2xl border border-bg-border p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-content">Активные X-аккаунты после фильтров</h2>
                  <p className="mt-1 text-xs text-content-faint">Кто чаще и сильнее продвигает токен в выбранном окне.</p>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-content-faint">top {Math.min(12, twitter.shillers.length)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {twitter.shillers.slice(0, 12).map((account) => (
                  <a key={account.handle} href={`https://x.com/${account.handle}`} target="_blank" rel="noreferrer noopener" className={clsx("group flex items-center gap-2 rounded-xl border px-3 py-2 transition", account.isBot ? "border-danger/25 bg-danger/5 hover:border-danger/45" : "border-bg-border bg-bg-elevated/60 hover:border-primary-border")}>
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-bg-border bg-bg-card text-[10px] font-bold text-content-muted">{account.handle.slice(0, 2).toUpperCase()}</div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-xs font-semibold text-content">@{account.handle}{account.isVerified && <BadgeCheck className="h-3 w-3 text-primary" />}{account.isBot && <Bot className="h-3 w-3 text-danger" />}</div>
                      <div className="mt-0.5 text-[10px] text-content-faint">{account.tweets} posts · {compact(account.totalEngagement)} eng · {account.followers == null ? "followers n/a" : `${compact(account.followers)} followers`}</div>
                    </div>
                  </a>
                ))}
              </div>
            </section>
          )}

          <section className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
            <div className="flex flex-col gap-3 border-b border-bg-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-content">Unified signal feed</h2>
                <p className="mt-1 text-xs text-content-faint">Отфильтрованные X + Telegram сигналы в одной ленте.</p>
              </div>
              <div className="flex flex-wrap gap-1 rounded-xl border border-bg-border bg-bg-card p-1">
                {(["all", "x", "telegram"] as const).map((source) => (
                  <button key={source} type="button" onClick={() => setSourceFilter(source)} className={clsx("rounded-lg px-3 py-1.5 text-[11px] font-semibold transition", sourceFilter === source ? "bg-primary-soft text-primary" : "text-content-muted hover:bg-bg-elevated hover:text-content")}>
                    {source === "all" ? "Все" : source === "x" ? "X / Twitter" : "Telegram"}
                  </button>
                ))}
              </div>
            </div>

            {mergedTimeline.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
                <Radar className="h-6 w-6 text-content-faint" />
                <div className="text-sm font-medium text-content-soft">Сигналы не прошли выбранные фильтры</div>
                <div className="max-w-md text-xs text-content-faint">Увеличь период, снизь min engagement / channel score или отключи verified-only.</div>
              </div>
            ) : (
              <div className="divide-y divide-bg-border">
                {mergedTimeline.map((item, index) => <SignalRow key={`${item.platform}-${item.source_handle || item.source_name}-${index}`} item={item} />)}
              </div>
            )}
          </section>
        </>
      ) : (
        <EmptyState overviewLoading={overviewLoading} channels={channels} callers={callers} />
      )}

      {(channels.length > 0 || callers.length > 0) && (
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
            <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-content"><Send className="h-4 w-4" /> Telegram channels</div>
              <span className="text-[10px] text-content-faint">global reputation</span>
            </div>
            <div className="divide-y divide-bg-border">
              {channels.slice(0, 8).map((channel) => (
                <div key={channel.id} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-content">{channel.title || channel.username || `channel ${channel.id}`}</div>
                    <div className="mt-1 text-[10px] text-content-faint">{compact(channel.participants)} members · {channel.calls_count} calls · rug {(channel.rug_rate * 100).toFixed(0)}%</div>
                  </div>
                  <div className="text-right"><div className="font-mono text-sm font-bold text-primary">{channel.score.toFixed(0)}</div><div className="text-[9px] uppercase tracking-wider text-content-faint">score</div></div>
                </div>
              ))}
            </div>
          </section>

          <section className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
            <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-content"><Users className="h-4 w-4" /> Top callers</div>
              <span className="text-[10px] text-content-faint">Telegram authors</span>
            </div>
            <div className="divide-y divide-bg-border">
              {callers.slice(0, 8).map((caller) => (
                <div key={caller.username} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-content">@{caller.username}</div>
                    <div className="mt-1 text-[10px] text-content-faint">{caller.calls} calls · win {(caller.win_rate * 100).toFixed(0)}% · avg {caller.avg_roi.toFixed(1)}x</div>
                  </div>
                  <div className="text-right"><div className="font-mono text-sm font-bold text-primary">{caller.score.toFixed(0)}</div><div className="text-[9px] uppercase tracking-wider text-content-faint">score</div></div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ParameterField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-content-faint">
        <span>{label}</span>{hint ? <span className="normal-case tracking-normal text-content-faint/70">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-bg-border bg-bg-elevated/50 px-3 py-2 text-[11px] text-content-soft">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-[color:var(--theme-primary)]" />
      <span>{label}</span>
    </label>
  );
}

function SignalRow({ item }: { item: TimelineItem }) {
  const telegram = item.platform === "telegram";
  const metrics = item.metrics || {};
  const source = item.source_handle || item.source_name || (telegram ? "Telegram" : "X");
  return (
    <article className="px-4 py-4 transition hover:bg-bg-elevated/35">
      <div className="flex items-start gap-3">
        <div className={clsx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", telegram ? "border-[color-mix(in_srgb,var(--theme-secondary)_28%,transparent)] bg-[color-mix(in_srgb,var(--theme-secondary)_10%,transparent)] text-[color:var(--theme-secondary)]" : "border-bg-border bg-bg-elevated text-content-soft")}>
          {telegram ? <Send className="h-4 w-4" /> : <Twitter className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-content">{source.startsWith("@") ? source : `@${source}`}</span>
            <span className="rounded-full border border-bg-border bg-bg-card px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-content-faint">{telegram ? "TG" : "X"}</span>
            {telegram && metrics.explicit_call === true && <span className="rounded-full border border-primary-border bg-primary-soft px-1.5 py-0.5 text-[9px] font-semibold text-primary">CALL</span>}
            <span className="inline-flex items-center gap-1 text-[10px] text-content-faint"><Clock3 className="h-3 w-3" />{relativeTime(item.occurred_at)}</span>
            {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-[10px] text-content-faint hover:text-content">открыть <ExternalLink className="h-3 w-3" /></a>}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-content-soft">{item.text}</p>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-content-faint">
            {typeof metrics.views === "number" && metrics.views > 0 && <span>{compact(metrics.views)} views</span>}
            {typeof metrics.likes === "number" && <span>{compact(metrics.likes)} likes</span>}
            {typeof metrics.retweets === "number" && <span>{compact(metrics.retweets)} reposts</span>}
            {typeof metrics.reactions === "number" && <span>{compact(metrics.reactions)} reactions</span>}
            {typeof metrics.forwards === "number" && <span>{compact(metrics.forwards)} forwards</span>}
            {metrics.suspicious === true && <span className="text-danger">suspicious</span>}
          </div>
        </div>
      </div>
    </article>
  );
}

function MiniMetric({ label, value, icon, tone = "default" }: { label: string; value: string; icon: React.ReactNode; tone?: "default" | "warning" | "danger" }) {
  return (
    <div className={clsx("rounded-xl border px-3 py-2", tone === "danger" ? "border-danger/25 bg-danger/5" : tone === "warning" ? "border-warning/25 bg-warning/5" : "border-bg-border bg-bg-card")}>
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-content-faint">{icon}{label}</div>
      <div className={clsx("mt-1 font-mono text-sm font-bold", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-content")}>{value}</div>
    </div>
  );
}

function MetricCard({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card/60 p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-content-faint">{icon}{label}</div>
      <div className="mt-2 font-mono text-xl font-bold text-content">{value}</div>
      <div className="mt-1 text-[10px] text-content-faint">{detail}</div>
    </div>
  );
}

function SocialSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="surface-panel rounded-2xl border border-bg-border p-5">
        <div className="h-6 w-44 animate-pulse rounded-lg bg-bg-elevated" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded-lg bg-bg-elevated" />
        <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl border border-bg-border bg-bg-elevated/50" />)}</div>
      </div>
    </div>
  );
}

function EmptyState({ overviewLoading, channels, callers }: { overviewLoading: boolean; channels: ChannelRow[]; callers: CallerRow[] }) {
  return (
    <section className="surface-panel rounded-2xl border border-bg-border px-6 py-14 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-primary-border bg-primary-soft text-primary">{overviewLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Network className="h-5 w-5" />}</div>
      <h2 className="mt-4 text-base font-semibold text-content">Настрой параметры и запусти единый анализ</h2>
      <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-content-muted">Mint обязателен. Ticker/X handle ускоряют поиск, а Telegram-фильтры отсекают слабые каналы и обычные упоминания до построения ленты.</p>
      <div className="mx-auto mt-5 flex max-w-xl flex-wrap justify-center gap-2 text-[10px] text-content-faint">
        <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">X mentions + quality filters</span>
        <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">TG calls + channel score</span>
        <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">Shared lookback window</span>
        {(channels.length > 0 || callers.length > 0) && <span className="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1 text-primary">Telegram DB connected</span>}
      </div>
    </section>
  );
}
