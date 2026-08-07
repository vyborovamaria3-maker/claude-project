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

interface TweetRow {
  id: string;
  text: string;
  author: string;
  likes: number;
  retweets: number;
  views: number;
  timestamp: number;
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
      const cached = socialCache.get(clean);
      if (!deep && cached && Date.now() - cached.fetchedAt < CLIENT_CACHE_TTL) {
        setTwitter(cached.twitter);
        setTimeline(cached.timeline);
        setWarnings(cached.warnings);
        return;
      }

      const strategy = deep ? "playwright" : "auto";
      const [xResult, timelineResult] = await Promise.allSettled([
        getJson<TwitterStats>(
          `/api/trade/dev-twitter?mint=${encodeURIComponent(clean)}&strategy=${strategy}&scope=mentions`,
          controller.signal,
        ),
        getJson<SocialTimeline>(`${BACKEND}/api/v1/social/token/${encodeURIComponent(clean)}`, controller.signal),
      ]);

      if (controller.signal.aborted) return;

      const nextWarnings: string[] = [];
      const nextTwitter = xResult.status === "fulfilled" ? xResult.value : null;
      const nextTimeline = timelineResult.status === "fulfilled" ? timelineResult.value : null;

      if (xResult.status === "rejected") nextWarnings.push(`X: ${xResult.reason instanceof Error ? xResult.reason.message : "нет данных"}`);
      if (timelineResult.status === "rejected") nextWarnings.push(`TG timeline: ${timelineResult.reason instanceof Error ? timelineResult.reason.message : "нет данных"}`);

      if (!nextTwitter && !nextTimeline) {
        throw new Error(nextWarnings.join(" · ") || "Не удалось получить social intelligence данные");
      }

      setTwitter(nextTwitter);
      setTimeline(nextTimeline);
      setWarnings(nextWarnings);
      socialCache.set(clean, {
        twitter: nextTwitter,
        timeline: nextTimeline,
        fetchedAt: Date.now(),
        warnings: nextWarnings,
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "Ошибка Social Intelligence");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setDeepLoading(false);
      }
    }
  }, [router]);

  useEffect(() => {
    if (didInitialLoad.current || !initialMint || !SOLANA_MINT_RE.test(initialMint)) return;
    didInitialLoad.current = true;
    void runAnalysis(initialMint);
  }, [initialMint, runAnalysis]);

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
        occurred_at: new Date(tweet.timestamp).toISOString(),
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
      .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
      .slice(0, 40);
  }, [timeline, twitter, sourceFilter]);

  const telegramMentions = timeline?.platforms?.telegram || 0;
  const xMentions = twitter?.totalTweets ?? timeline?.platforms?.x ?? 0;
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
              <span className="rounded-full border border-bg-border bg-bg-elevated/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-muted">
                X + Telegram
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-content-muted">
              Социальные сигналы по mint: X-упоминания, подозрительные аккаунты, Telegram calls, каналы и единая временная лента.
            </p>
          </div>
        </div>
        {twitter && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-content-faint">
            <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">
              {twitter.collectionStrategy} · {twitter.performance.cached ? "cache" : `${twitter.performance.responseTimeMs} ms`}
            </span>
            <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">
              обновлено {relativeTime(twitter.lastUpdated)} назад
            </span>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Вставь Solana mint / CA"
            autoComplete="off"
            spellCheck={false}
            className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
            aria-label="Solana mint address"
          />
        </div>
        <button type="submit" disabled={busy} className={siteDesign.controls.primaryActionClassName}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
          Анализировать
        </button>
        {mint && (
          <button
            type="button"
            onClick={() => void runAnalysis(mint, false)}
            disabled={busy}
            className={siteDesign.controls.actionButtonClassName}
            title="Повторно получить данные"
          >
            <RefreshCw className={clsx("h-4 w-4", loading && "animate-spin")} />
            Обновить
          </button>
        )}
        {mint && (
          <button
            type="button"
            onClick={() => void runAnalysis(mint, true)}
            disabled={busy}
            className={siteDesign.controls.actionButtonClassName}
            title="Глубокий сбор X через Playwright"
          >
            {deepLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Deep X
          </button>
        )}
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
                  <h2 className="text-2xl font-bold tracking-tight text-content">{twitter?.symbol ? `$${twitter.symbol}` : "Token"}</h2>
                  <span className="font-mono text-xs text-content-faint">{shortMint(mint)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-content-muted">
                  {twitter?.twitterHandle ? (
                    <a
                      href={`https://x.com/${twitter.twitterHandle}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5 transition hover:border-primary-border hover:text-content"
                    >
                      <Twitter className="h-3.5 w-3.5" />@{twitter.twitterHandle}<ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5">официальный X не определён</span>
                  )}
                  {telegramMentions > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5">
                      <Send className="h-3.5 w-3.5" /> Telegram signals: {telegramMentions}
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[480px]">
                <MiniMetric label="Signals" value={compact(totalSignals)} icon={<Zap className="h-3.5 w-3.5" />} />
                <MiniMetric label="Authors" value={compact(twitter?.uniqueMentioners || 0)} icon={<Users className="h-3.5 w-3.5" />} />
                <MiniMetric label="Engagement" value={compact(twitter?.aggregated.totalEngagement || 0)} icon={<MessageCircle className="h-3.5 w-3.5" />} />
                <MiniMetric
                  label="Bot risk"
                  value={twitter ? `${twitter.botRiskScore}/100` : "—"}
                  icon={<ShieldAlert className="h-3.5 w-3.5" />}
                  tone={twitter?.botRisk === "high" ? "danger" : twitter?.botRisk === "medium" ? "warning" : "default"}
                />
              </div>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="X mentions"
                value={compact(xMentions)}
                detail={`${compact(twitter?.totalViews || 0)} views · ${compact(twitter?.totalLikes || 0)} likes`}
                icon={<Twitter className="h-4 w-4" />}
              />
              <MetricCard
                label="Telegram"
                value={compact(telegramMentions)}
                detail={timeline?.origin?.platform === "telegram" ? `first signal ${relativeTime(timeline.origin.occurred_at)} ago` : "stored TG intelligence"}
                icon={<Send className="h-4 w-4" />}
              />
              <MetricCard
                label="Bot / anomalies"
                value={compact(twitter?.anomalyCount || 0)}
                detail={twitter ? `${percent(twitter.aggregated.botRatio)} suspicious posts` : "—"}
                icon={<Bot className="h-4 w-4" />}
              />
              <MetricCard
                label="Engagement rate"
                value={twitter ? percent(twitter.aggregated.engagementRate) : "—"}
                detail={twitter ? `${twitter.aggregated.verifiedAuthors} verified authors` : "—"}
                icon={<Gauge className="h-4 w-4" />}
              />
            </div>
          </section>

          {twitter && twitter.shillers.length > 0 && (
            <section className="surface-panel rounded-2xl border border-bg-border p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-content">Активные аккаунты</h2>
                  <p className="mt-1 text-xs text-content-faint">Кто чаще и сильнее продвигает токен в X.</p>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-content-faint">top {Math.min(12, twitter.shillers.length)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {twitter.shillers.slice(0, 12).map((account) => (
                  <a
                    key={account.handle}
                    href={`https://x.com/${account.handle}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={clsx(
                      "group flex items-center gap-2 rounded-xl border px-3 py-2 transition",
                      account.isBot
                        ? "border-danger/25 bg-danger/5 hover:border-danger/45"
                        : "border-bg-border bg-bg-elevated/60 hover:border-primary-border",
                    )}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-bg-border bg-bg-card text-[10px] font-bold text-content-muted">
                      {account.handle.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-xs font-semibold text-content">
                        @{account.handle}
                        {account.isVerified && <BadgeCheck className="h-3 w-3 text-primary" />}
                        {account.isBot && <Bot className="h-3 w-3 text-danger" />}
                      </div>
                      <div className="mt-0.5 text-[10px] text-content-faint">
                        {account.tweets} posts · {compact(account.totalEngagement)} eng · {compact(account.followers || 0)} followers
                      </div>
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
                <p className="mt-1 text-xs text-content-faint">Последние X + Telegram сигналы в одной ленте.</p>
              </div>
              <div className="flex flex-wrap gap-1 rounded-xl border border-bg-border bg-bg-card p-1">
                {(["all", "x", "telegram"] as const).map((source) => (
                  <button
                    key={source}
                    type="button"
                    onClick={() => setSourceFilter(source)}
                    className={clsx(
                      "rounded-lg px-3 py-1.5 text-[11px] font-semibold transition",
                      sourceFilter === source
                        ? "bg-primary-soft text-primary"
                        : "text-content-muted hover:bg-bg-elevated hover:text-content",
                    )}
                  >
                    {source === "all" ? "Все" : source === "x" ? "X / Twitter" : "Telegram"}
                  </button>
                ))}
              </div>
            </div>

            {mergedTimeline.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
                <Radar className="h-6 w-6 text-content-faint" />
                <div className="text-sm font-medium text-content-soft">Сигналы пока не найдены</div>
                <div className="max-w-md text-xs text-content-faint">Попробуй Deep X или другой mint. Telegram появится после подключения user-session и сбора каналов.</div>
              </div>
            ) : (
              <div className="divide-y divide-bg-border">
                {mergedTimeline.map((item, index) => (
                  <SignalRow key={`${item.platform}-${item.source_handle || item.source_name}-${index}`} item={item} />
                ))}
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
                  <div className="text-right">
                    <div className="font-mono text-sm font-bold text-primary">{channel.score.toFixed(0)}</div>
                    <div className="text-[9px] uppercase tracking-wider text-content-faint">score</div>
                  </div>
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
                  <div className="text-right">
                    <div className="font-mono text-sm font-bold text-primary">{caller.score.toFixed(0)}</div>
                    <div className="text-[9px] uppercase tracking-wider text-content-faint">score</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SignalRow({ item }: { item: TimelineItem }) {
  const telegram = item.platform === "telegram";
  const metrics = item.metrics || {};
  const source = item.source_handle || item.source_name || (telegram ? "Telegram" : "X");
  return (
    <article className="px-4 py-4 transition hover:bg-bg-elevated/35">
      <div className="flex items-start gap-3">
        <div className={clsx(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
          telegram
            ? "border-[color-mix(in_srgb,var(--theme-secondary)_28%,transparent)] bg-[color-mix(in_srgb,var(--theme-secondary)_10%,transparent)] text-[color:var(--theme-secondary)]"
            : "border-bg-border bg-bg-elevated text-content-soft",
        )}>
          {telegram ? <Send className="h-4 w-4" /> : <Twitter className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-content">{source.startsWith("@") ? source : `@${source}`}</span>
            <span className="rounded-full border border-bg-border bg-bg-card px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-content-faint">{telegram ? "TG" : "X"}</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-content-faint"><Clock3 className="h-3 w-3" />{relativeTime(item.occurred_at)}</span>
            {item.source_url && (
              <a href={item.source_url} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-[10px] text-content-faint hover:text-content">
                открыть <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-content-soft">{item.text}</p>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-content-faint">
            {typeof metrics.views === "number" && metrics.views > 0 && <span>{compact(metrics.views)} views</span>}
            {typeof metrics.likes === "number" && <span>{compact(metrics.likes)} likes</span>}
            {typeof metrics.retweets === "number" && <span>{compact(metrics.retweets)} reposts</span>}
            {metrics.suspicious === true && <span className="text-danger">suspicious</span>}
          </div>
        </div>
      </div>
    </article>
  );
}

function MiniMetric({ label, value, icon, tone = "default" }: { label: string; value: string; icon: React.ReactNode; tone?: "default" | "warning" | "danger" }) {
  return (
    <div className={clsx(
      "rounded-xl border px-3 py-2",
      tone === "danger" ? "border-danger/25 bg-danger/5" : tone === "warning" ? "border-warning/25 bg-warning/5" : "border-bg-border bg-bg-card",
    )}>
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
        <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl border border-bg-border bg-bg-elevated/50" />)}
        </div>
      </div>
      <div className="surface-panel rounded-2xl border border-bg-border p-4">
        {[0, 1, 2].map((item) => <div key={item} className="mb-2 h-20 animate-pulse rounded-xl bg-bg-elevated/50 last:mb-0" />)}
      </div>
    </div>
  );
}

function EmptyState({ overviewLoading, channels, callers }: { overviewLoading: boolean; channels: ChannelRow[]; callers: CallerRow[] }) {
  return (
    <section className="surface-panel rounded-2xl border border-bg-border px-6 py-14 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-primary-border bg-primary-soft text-primary">
        {overviewLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Network className="h-5 w-5" />}
      </div>
      <h2 className="mt-4 text-base font-semibold text-content">Один mint — единая social-картина</h2>
      <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-content-muted">
        Вставь CA выше. X и сохранённая Telegram-история грузятся параллельно; повторные запросы используют короткий клиентский кеш и серверный кеш X.
      </p>
      <div className="mx-auto mt-5 flex max-w-xl flex-wrap justify-center gap-2 text-[10px] text-content-faint">
        <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">X mentions + bot risk</span>
        <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">TG calls + channels</span>
        <span className="rounded-full border border-bg-border bg-bg-card px-2.5 py-1">Unified timeline</span>
        {(channels.length > 0 || callers.length > 0) && <span className="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1 text-primary">Telegram DB connected</span>}
      </div>
    </section>
  );
}
