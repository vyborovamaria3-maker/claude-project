"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CheckCircle, Coins, ExternalLink, Globe2, Loader2, Newspaper, RefreshCw, Search, Sparkles, TrendingUp, Twitter, Users, Zap } from "lucide-react";
import type { TwitterStats } from "@/app/api/trade/dev-twitter/route";
import type { TrendingToken } from "@/app/api/trending/route";
import type { XTrendItem as TrendItem, XTrendsResponse, MemeCoinToken, MemeCoinNarrative, FearGreedData } from "@/app/api/x-analysis/trends/route";
import { readCachedValue, removeCachedValue, useCachedValue, writeCachedValue } from "@/lib/client-cache";
import { useI18n } from "@/components/providers/I18nProvider";

type Strategy = "auto" | "nitter" | "playwright";
type MainTab = "trends" | "monitoring";
type TrendCategory = "world" | "crypto" | "solana";
type MemeTwitterState = {
  selectedMint: string | null;
  loadingMint: string | null;
  errorByMint: Record<string, string>;
  dataByMint: Record<string, TwitterStats>;
};

const X_ANALYSIS_TRENDS_CACHE_TTL_MS = 5 * 60_000;
const X_ANALYSIS_MONITORING_CACHE_TTL_MS = 3 * 60_000;

function getTrendsCacheKey(lang: "ru" | "en") {
  return `solana-launcher.x-analysis.trends.${lang}`;
}

function getAnalysisCacheKey(requestUrl: string) {
  return `solana-launcher.x-analysis.monitoring.${requestUrl}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildFallbackXTrends(trendingTokens: TrendingToken[], lang: "ru" | "en"): XTrendsResponse {
  const items = trendingTokens.map((token, index) => ({
    title: `${token.ticker} В· ${token.name} В· ${token.price}`,
    source: "DexScreener trending",
    url: `https://dexscreener.com/solana/${token.mint}`,
    publishedAt: Date.now() - index * 60_000,
    category: index < 3 ? "world" : index < 6 ? "crypto" : "solana",
    score: Math.max(100 - index * 5, 10),
    tickers: [token.ticker.replace(/^\$/, "")],
    keywords: ["trending", "solana", "memecoin"],
  })) as TrendItem[];

  const categories: XTrendsResponse["categories"] = {
    world: items.slice(0, 3),
    crypto: items.slice(3, 6),
    solana: items.slice(6),
  };

  const hotKeywords = [
    { keyword: lang === "ru" ? "РўСЂРµРЅРґС‹" : "Trending", count: Math.max(trendingTokens.length, 1), categories: ["world", "crypto", "solana"] as TrendCategory[] },
    { keyword: "Solana", count: Math.max(Math.min(trendingTokens.length, 5), 1), categories: ["solana"] as TrendCategory[] },
    { keyword: "Memecoin", count: Math.max(Math.min(trendingTokens.length, 5), 1), categories: ["crypto", "solana"] as TrendCategory[] },
  ] satisfies XTrendsResponse["hotKeywords"];

  const hotTickers = trendingTokens.slice(0, 10).map((token, index) => ({
    ticker: token.ticker.replace(/^\$/, ""),
    count: Math.max(1, 10 - index),
    categories: (index < 3 ? ["world", "crypto"] : ["solana"]) as TrendCategory[],
  })) satisfies XTrendsResponse["hotTickers"];

  return {
    updatedAt: Date.now(),
    categories,
    hotKeywords,
    hotTickers,
    memecoins: {
      topGainers: [],
      topVolume: [],
      solanaMemes: [],
      narratives: [],
      fearGreed: null,
      totalMemeVolume24h: 0,
      dominantNarrative: null,
      momentumShift: "neutral",
    },
  };
}

function isXTrendsResponse(value: unknown): value is XTrendsResponse {
  if (!isRecord(value)) return false;

  const categories = value.categories;
  const hotKeywords = value.hotKeywords;
  const hotTickers = value.hotTickers;
  const memecoins = value.memecoins;

  if (!isRecord(categories)) return false;
  if (!Array.isArray(categories.world) || !Array.isArray(categories.crypto) || !Array.isArray(categories.solana)) return false;
  if (!Array.isArray(hotKeywords) || !Array.isArray(hotTickers)) return false;
  if (!isRecord(memecoins)) return false;
  if (!Array.isArray(memecoins.topGainers) || !Array.isArray(memecoins.topVolume) || !Array.isArray(memecoins.solanaMemes)) return false;
  if (!Array.isArray(memecoins.narratives)) return false;

  return true;
}


export default function XAnalysisPage() {
  const { t } = useI18n();
  const [mint, setMint] = useState("");
  const [symbol, setSymbol] = useState("");
  const [twitter, setTwitter] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("auto");
  const [activeTab, setActiveTab] = useState<MainTab>("monitoring");
  const [data, setData] = useState<TwitterStats | null>(null);
  const [trends, setTrends] = useState<XTrendsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingTrends, setLoadingTrends] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [trendsLang, setTrendsLang] = useState<"ru" | "en">("ru");
  const mintInputRef = useRef<HTMLInputElement | null>(null);
  const trendsLoadedLangRef = useRef<"ru" | "en" | null>(null);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (mint.trim()) params.set("mint", mint.trim());
    if (symbol.trim()) params.set("symbol", symbol.trim());
    if (twitter.trim()) params.set("twitter", twitter.trim());
    params.set("strategy", strategy);
    params.set("scope", "official");
    return `/api/trade/dev-twitter?${params.toString()}`;
  }, [mint, symbol, twitter, strategy]);

  const trendsCacheKey = useMemo(() => getTrendsCacheKey(trendsLang), [trendsLang]);
  const cachedTrends = useCachedValue<XTrendsResponse>(trendsCacheKey);
  const analysisCacheKey = useMemo(() => getAnalysisCacheKey(requestUrl), [requestUrl]);
  const cachedAnalysis = useCachedValue<TwitterStats>(analysisCacheKey);
  const trendsData = useMemo(() => (isXTrendsResponse(trends) ? trends : null), [trends]);

  useEffect(() => {
    if (cachedAnalysis) {
      setData(cachedAnalysis);
      setError(null);
    }
  }, [cachedAnalysis, analysisCacheKey]);

  useEffect(() => {
    if (cachedTrends && !isXTrendsResponse(cachedTrends)) {
      removeCachedValue(trendsCacheKey);
      setTrends(null);
      if (trendsLoadedLangRef.current === trendsLang) {
        trendsLoadedLangRef.current = null;
      }
      return;
    }

    setTrends(cachedTrends ?? null);
    if (cachedTrends) {
      trendsLoadedLangRef.current = trendsLang;
    } else if (trendsLoadedLangRef.current === trendsLang) {
      trendsLoadedLangRef.current = null;
    }
  }, [cachedTrends, trendsLang, trendsCacheKey]);

  async function runAnalysis() {
    if (!mint.trim()) {
      setError(t("xAnalysis.error.mintRequired"));
      return;
    }

    const cached = readCachedValue<TwitterStats>(analysisCacheKey);
    if (cached) {
      setData(cached);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(requestUrl, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
      writeCachedValue(analysisCacheKey, payload, X_ANALYSIS_MONITORING_CACHE_TTL_MS);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadTrends(force = false) {
    if (!force && trendsData && trendsLoadedLangRef.current === trendsLang) {
      return;
    }

    if (!force && cachedTrends) {
      setTrends(cachedTrends);
      trendsLoadedLangRef.current = trendsLang;
      return;
    }

    setLoadingTrends(true);
    setTrendsError(null);
    try {
      const response = await fetch(`/api/x-analysis/trends?lang=${trendsLang}`, { cache: "no-store" });
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      let payload: unknown = null;

      if (contentType.includes("application/json")) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = null;
        }
      }

      if (!response.ok || !isXTrendsResponse(payload)) {
        const fallback = await fetch("/api/trending", { cache: "no-store" });
        const fallbackPayload = (await fallback.json()) as TrendingToken[];
        setTrends(buildFallbackXTrends(Array.isArray(fallbackPayload) ? fallbackPayload : [], trendsLang));
        trendsLoadedLangRef.current = trendsLang;
        return;
      }

      setTrends(payload);
      trendsLoadedLangRef.current = trendsLang;
      writeCachedValue(trendsCacheKey, payload, X_ANALYSIS_TRENDS_CACHE_TTL_MS);
    } catch (e) {
      try {
        const fallback = await fetch("/api/trending", { cache: "no-store" });
        const fallbackPayload = (await fallback.json()) as TrendingToken[];
        setTrends(buildFallbackXTrends(Array.isArray(fallbackPayload) ? fallbackPayload : [], trendsLang));
        trendsLoadedLangRef.current = trendsLang;
        setTrendsError(null);
      } catch {
        setTrendsError((e as Error).message);
      }
    } finally {
      setLoadingTrends(false);
    }
  }

  useEffect(() => {
    if (activeTab === "trends") {
      loadTrends();
    }
  }, [activeTab, trendsLang]);

  useEffect(() => {
    if (activeTab === "monitoring") {
      window.setTimeout(() => mintInputRef.current?.focus(), 0);
    }
  }, [activeTab]);

  return (
    <div data-tag="page.x-analysis" className="w-full max-w-[1400px] mx-auto space-y-6 py-6">
      <section className="surface-panel-hero relative overflow-hidden p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-content-muted">
              <Sparkles className="w-3.5 h-3.5" />
              Memecoin Twitter intelligence
            </div>
            <h1 className="mt-3 text-2xl md:text-3xl font-bold text-content">РђРЅР°Р»РёР· X</h1>
            <p className="mt-1 text-sm text-content-muted max-w-2xl">
              Twitter/X РїРѕС‚РѕРє РїРѕ РјРµРјРєРѕРёРЅР°Рј: С‚СЂРµРЅРґС‹, calls, shillers Рё РіРѕСЂСЏС‡РёРµ С‚РёРєРµСЂС‹ Р±РµР· Р»РёС€РЅРёС… dev-Р±Р»РѕРєРѕРІ.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/50">
            <Zap className="w-4 h-4 text-[color:var(--theme-warning)]" />
            Strategy: <span className="text-white font-semibold">{strategy}</span>
          </div>
        </div>
      </section>

      <section className="surface-panel p-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {([
            { key: "trends", label: "РўСЂРµРЅРґС‹" },
            { key: "monitoring", label: "РњРѕРЅРёС‚РѕСЂРёРЅРі С‚РѕРєРµРЅР°" },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-xl px-4 py-3 text-sm font-semibold transition border ${activeTab === tab.key ? "border-bg-border/70 bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] text-white" : "border-transparent bg-white/5 text-white/55 hover:text-white hover:bg-white/10"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {activeTab === "trends" && (
        <section className="surface-panel rounded-2xl border border-bg-border p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2"><Newspaper className="w-5 h-5 text-[color:var(--theme-primary)]" />{t("xAnalysis.trends.title")}</h2>
              <p className="text-xs text-white/45 mt-1">{t("xAnalysis.trends.subtitle")}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setTrendsLang(trendsLang === "ru" ? "en" : "ru")} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/15 px-3 py-2 text-xs text-white/70 hover:text-white hover:border-white/30 transition">
                <Globe2 className="w-3.5 h-3.5" />
                {trendsLang === "ru" ? "EN" : "RU"}
              </button>
              <button onClick={() => loadTrends(true)} disabled={loadingTrends} className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-xs text-white/70 hover:text-white disabled:opacity-50">
                {loadingTrends ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {t("xAnalysis.trends.refresh")}
              </button>
            </div>
          </div>

          {trendsError && (
            <div className="flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] px-3 py-2 text-sm text-[color:var(--theme-danger)]">
              <AlertTriangle className="w-4 h-4" />
              {trendsError}
            </div>
          )}

          {trendsData ? (
            <>
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <TrendColumn title={t("xAnalysis.trends.world")} subtitle={t("xAnalysis.trends.worldSub")} icon={<Globe2 className="w-4 h-4 text-blue-300" />} items={trendsData.categories.world} accent="blue" noDataText={t("xAnalysis.trends.noData")} />
                <TrendColumn title={t("xAnalysis.trends.crypto")} subtitle={t("xAnalysis.trends.cryptoSub")} icon={<Coins className="w-4 h-4 text-[color:var(--theme-warning)]" />} items={trendsData.categories.crypto} accent="yellow" noDataText={t("xAnalysis.trends.noData")} />
                <TrendColumn title={t("xAnalysis.trends.solana")} subtitle={t("xAnalysis.trends.solanaSub")} icon={<Zap className="w-4 h-4 text-[color:var(--theme-secondary)]" />} items={trendsData.categories.solana} accent="purple" noDataText={t("xAnalysis.trends.noData")} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <HotPills title={t("xAnalysis.trends.hotTopics")} items={trendsData.hotKeywords.map((item) => ({ label: item.keyword, count: item.count }))} />
                <HotPills title={t("xAnalysis.trends.hotTickers")} items={trendsData.hotTickers.map((item) => ({ label: `$${item.ticker}`, count: item.count }))} />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {[0, 1, 2].map((item) => <div key={item} className="h-64 rounded-2xl border border-bg-border bg-white/5 animate-pulse" />)}
            </div>
          )}
        </section>
      )}

      {activeTab === "monitoring" && (
        <div className="space-y-4">
          <section className="surface-panel font-sans relative overflow-hidden rounded-[30px] p-5 md:p-6 shadow-[0_30px_80px_rgba(2,8,23,0.45)] space-y-5">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.2),transparent_30%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.18),transparent_28%),linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:auto,auto,28px_28px,28px_28px] opacity-60" />
            <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
            <div className="relative flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-bg-border/70 bg-white/5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                  <Twitter className="w-3.5 h-3.5" />
                  {t("xAnalysis.monitoring.title")}
                </div>
                <div>
                  <h2 className="text-[32px] md:text-[40px] font-semibold tracking-[-0.035em] leading-none text-white">{t("xAnalysis.monitoring.heading")}</h2>
                  <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-300/88">{t("xAnalysis.monitoring.subtitle")}</p>
                </div>
              </div>
              <div className="relative grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                <BadgePill label={t("xAnalysis.field.strategy")} value={strategy} tone="sky" />
                <BadgePill label={t("xAnalysis.quickStart")} value="Enter в†µ" tone="violet" />
                {data ? <BadgePill label={t("xAnalysis.authors")} value={data.uniqueMentioners.toString()} tone="emerald" /> : null}
                {data ? <BadgePill label={t("xAnalysis.risk")} value={`${data.botRisk} ${data.botRiskScore}/100`} tone={data.botRisk === "high" ? "red" : data.botRisk === "medium" ? "amber" : "emerald"} /> : null}
              </div>
            </div>

            <div className="surface-panel-hero relative rounded-[26px] p-4 md:p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[1.2fr_0.7fr_1fr_0.65fr_auto] gap-3 items-end">
                <Field label={t("xAnalysis.field.mint")}>
                  <input
                    ref={mintInputRef}
                    value={mint}
                    onChange={(e) => setMint(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        runAnalysis();
                      }
                    }}
                    placeholder={t("xAnalysis.mintPlaceholder")}
                    className="monitoring-control h-12"
                  />
                </Field>
                <Field label={t("xAnalysis.field.symbol")}>
                  <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={t("xAnalysis.symbolPlaceholder")} className="monitoring-control h-12" />
                </Field>
                <Field label={t("xAnalysis.field.twitter")}>
                  <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder={t("xAnalysis.twitterPlaceholder")} className="monitoring-control h-12" />
                </Field>
                <Field label={t("xAnalysis.field.strategy")}>
                  <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)} className="monitoring-control h-12 pr-10">
                    <option value="auto">auto</option>
                    <option value="nitter">nitter</option>
                    <option value="playwright">playwright</option>
                  </select>
                </Field>
                <button onClick={runAnalysis} disabled={loading} className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sky-400 via-cyan-300 to-sky-300 px-5 text-sm font-semibold text-slate-950 shadow-[0_14px_40px_rgba(56,189,248,0.24)] hover:brightness-105 disabled:opacity-50 transition">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  {t("xAnalysis.analyze")}
                </button>
              </div>

              {data && (
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
                  <MiniPulseCard label={t("xAnalysis.metric.tweets")} value={data.totalTweets.toString()} hint={t("xAnalysis.hint.tweets")} />
                  <MiniPulseCard label={t("xAnalysis.metric.views")} value={fmt(data.totalViews)} hint={t("xAnalysis.hint.views")} />
                  <MiniPulseCard label={t("xAnalysis.metric.engagement")} value={fmt(data.aggregated.totalEngagement)} hint={t("xAnalysis.hint.engagement")} />
                  <MiniPulseCard label={t("xAnalysis.metric.tweets")} value={data.uniqueMentioners.toString()} hint={t("xAnalysis.hint.authors")} />
                </div>
              )}

              {error && (
                <div className="flex items-center gap-2 rounded-2xl border border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] px-3 py-3 text-sm text-[color:var(--theme-danger)]">
                  <AlertTriangle className="w-4 h-4" />
                  {error}
                </div>
              )}
            </div>
          </section>

          {data ? (
            <>
              <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Metric label={t("xAnalysis.metric.tweets")} value={data.totalTweets.toString()} accent="sky" />
                <Metric label={t("xAnalysis.metric.views")} value={fmt(data.totalViews)} accent="violet" />
                <Metric label={t("xAnalysis.metric.engagement")} value={fmt(data.aggregated.totalEngagement)} accent="emerald" />
                <Metric label={t("xAnalysis.metric.botRatio")} value={`${(data.aggregated.botRatio * 100).toFixed(1)}%`} accent={data.aggregated.botRatio >= 0.35 ? "red" : data.aggregated.botRatio >= 0.18 ? "amber" : "sky"} />
              </section>

              <section className="grid grid-cols-1 xl:grid-cols-[1fr_0.8fr] gap-4">
                <div className="surface-panel rounded-[26px] border border-[color-mix(in_srgb,var(--theme-primary)_15%,transparent)] bg-gradient-to-br from-[color-mix(in_srgb,var(--theme-primary)_8%,transparent)] to-transparent p-5 space-y-4 shadow-[0_10px_30px_rgba(14,165,233,0.08)]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-2"><Sparkles className="w-4 h-4 text-[color:var(--theme-primary)]" />{t("xAnalysis.keySignals")}</h3>
                      <p className="text-[11px] text-white/35 mt-0.5">{t("xAnalysis.keySignalsSubtitle")}</p>
                    </div>
                    <RiskBadge risk={data.botRisk} score={data.botRiskScore} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <Row label={t("xAnalysis.row.twitter")} value={data.twitterHandle ? `@${data.twitterHandle}` : "вЂ”"} href={data.twitterHandle ? `https://x.com/${data.twitterHandle}` : undefined} />
                    <Row label={t("xAnalysis.row.engagementRate")} value={`${(data.aggregated.engagementRate * 100).toFixed(2)}%`} />
                    <Row label={t("xAnalysis.row.avgViews")} value={fmt(data.avgViews)} />
                    <Row label={t("xAnalysis.row.suspicious")} value={`${data.aggregated.botSuspectedCount}/${data.totalTweets}`} />
                  </div>
                </div>

                <div className="surface-panel rounded-[26px] border border-bg-border p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-white">{t("xAnalysis.summary")}</h3>
                      <p className="text-[11px] text-white/35 mt-0.5">{data.symbol} В· {data.collectionStrategy}</p>
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/55">{t("xAnalysis.liveView")}</span>
                  </div>
                  <div className="space-y-2 text-xs">
                    <Row label={t("xAnalysis.row.mint")} value={short(data.mint)} />
                    <Row label={t("xAnalysis.row.avgLikes")} value={fmt(data.avgLikes)} />
                    <Row label={t("xAnalysis.row.avgRetweets")} value={fmt(data.avgRetweets)} />
                    <Row label={t("xAnalysis.row.response")} value={data.performance.cached ? t("xAnalysis.row.cached") : `${data.performance.responseTimeMs}ms`} />
                  </div>
                </div>
              </section>

              <details className="surface-panel rounded-[26px] border border-bg-border p-4 md:p-5">
                <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-white flex items-center gap-2"><Users className="w-4 h-4 text-[color:var(--theme-warning)]" />{t("xAnalysis.shillers")}</span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/45">{data.shillers.length} {t("xAnalysis.accounts")}</span>
                </summary>
                <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
                  {data.shillers.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-white/40">{t("xAnalysis.noAccounts")}</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-white/5 text-white/40">
                        <tr>
                          <th className="px-3 py-2 text-left">{t("xAnalysis.table.handle")}</th>
                          <th className="px-3 py-2 text-right">{t("xAnalysis.table.tweets")}</th>
                          <th className="px-3 py-2 text-right">{t("xAnalysis.table.engagement")}</th>
                          <th className="px-3 py-2 text-center">Bot</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.shillers.slice(0, 12).map((item) => (
                          <tr key={item.handle} className="border-t border-bg-border">
                            <td className="px-3 py-2"><a className="text-[color:var(--theme-primary)] hover:text-[color:var(--theme-secondary)]" href={`https://x.com/${item.handle}`} target="_blank" rel="noreferrer">@{item.handle}</a></td>
                            <td className="px-3 py-2 text-right text-white/70">{item.tweets}</td>
                            <td className="px-3 py-2 text-right text-white/70">{fmt(item.totalEngagement)}</td>
                            <td className="px-3 py-2 text-center">{item.isBot ? <Bot className="w-4 h-4 text-[color:var(--theme-danger)] mx-auto" /> : <CheckCircle className="w-4 h-4 text-[color:var(--theme-success)] mx-auto" />}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>

              <details className="surface-panel rounded-[26px] border border-[color-mix(in_srgb,var(--theme-primary)_15%,transparent)] bg-gradient-to-br from-[color-mix(in_srgb,var(--theme-primary)_8%,transparent)] to-transparent p-4 md:p-5">
                <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-white">РўРѕРї С‚РІРёС‚С‹</span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/45">{data.topTweets.length} tweets</span>
                </summary>
                <div className="mt-4 space-y-3">
                  {data.topTweets.length === 0 ? (
                    <p className="text-sm text-white/40">РќРµС‚ РЅР°Р№РґРµРЅРЅС‹С… С‚РІРёС‚РѕРІ.</p>
                  ) : (
                    data.topTweets.map((tweet) => (
                      <div key={tweet.id} className={`rounded-2xl border px-4 py-4 shadow-[0_10px_25px_rgba(15,23,42,0.18)] ${tweet.isSuspicious ? "border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_5%,transparent)]" : "border-white/10 bg-white/[0.04]"}`}>
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2">
                            <a href={`https://x.com/${tweet.author}`} target="_blank" rel="noreferrer" className="text-sm text-[color:var(--theme-primary)] hover:text-[color:var(--theme-secondary)] flex items-center gap-1">@{tweet.author}<ExternalLink className="w-3 h-3" /></a>
                            {tweet.isSuspicious ? <span className="rounded-full border border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--theme-danger)]">flagged</span> : null}
                          </div>
                          <div className="flex gap-3 text-xs text-white/40"><span>в™Ґ {fmt(tweet.likes)}</span><span>в†» {fmt(tweet.retweets)}</span><span>рџ‘Ѓ {fmt(tweet.views)}</span></div>
                        </div>
                        <p className="text-sm leading-6 text-white/75">{tweet.text}</p>
                      </div>
                    ))
                  )}
                </div>
              </details>

              {trendsData ? <MemeCoinDeepDive meme={trendsData.memecoins} /> : null}
            </>
          ) : (
            <section className="surface-panel font-sans relative overflow-hidden rounded-[30px] p-8 text-center shadow-[0_24px_60px_rgba(2,8,23,0.35)]">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_30%),linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:auto,30px_30px,30px_30px] opacity-70" />
              <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-bg-border/70 bg-white/5 text-white shadow-[0_10px_30px_rgba(56,189,248,0.16)]">
                <Twitter className="w-6 h-6" />
              </div>
              <h3 className="relative mt-4 text-[28px] font-semibold tracking-[-0.03em] text-white">РџРѕРґРіРѕС‚РѕРІСЊ С‚РѕРєРµРЅ Рє РјРѕРЅРёС‚РѕСЂРёРЅРіСѓ</h3>
              <p className="relative mt-3 text-[15px] leading-7 text-slate-300/75 max-w-xl mx-auto">Р’СЃС‚Р°РІСЊ mint, РїСЂРё РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё СѓРєР°Р¶Рё symbol РёР»Рё X handle Рё Р·Р°РїСѓСЃС‚Рё Р°РЅР°Р»РёР·. Р—РґРµСЃСЊ РїРѕСЏРІСЏС‚СЃСЏ engagement-СЃРёРіРЅР°Р»С‹, shillers, С‚РѕРї-С‚РІРёС‚С‹ Рё РјРµРјРєРѕРёРЅ-РєРѕРЅС‚РµРєСЃС‚.</p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="space-y-1.5 font-sans"><div className="monitoring-field-label text-[10px] text-white/35">{label}</div>{children}</label>;
}

function Metric({ label, value, accent = "sky" }: { label: string; value: string; accent?: "sky" | "violet" | "emerald" | "amber" | "red" }) {
  const accents: Record<string, string> = {
    sky: "border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] from-sky-500/12 to-transparent shadow-[0_10px_25px_rgba(56,189,248,0.12)]",
    violet: "border-violet-400/20 from-violet-500/12 to-transparent shadow-[0_10px_25px_rgba(168,85,247,0.12)]",
    emerald: "border-emerald-400/20 from-emerald-500/12 to-transparent shadow-[0_10px_25px_rgba(52,211,153,0.12)]",
    amber: "border-amber-400/20 from-amber-500/12 to-transparent shadow-[0_10px_25px_rgba(251,191,36,0.12)]",
    red: "border-red-400/20 from-red-500/12 to-transparent shadow-[0_10px_25px_rgba(248,113,113,0.12)]",
  };
  return <div className={`rounded-[24px] border bg-gradient-to-br p-4 ${accents[accent] || accents.sky}`}><div className="text-[10px] uppercase tracking-[0.2em] text-white/40">{label}</div><div className="mt-2 text-2xl font-black tracking-tight text-white">{value}</div></div>;
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5"><span className="text-white/45">{label}</span>{href ? <a href={href} target="_blank" rel="noreferrer" className="text-[color:var(--theme-primary)] hover:text-[color:var(--theme-primary)] flex items-center gap-1">{value}<ExternalLink className="w-3 h-3" /></a> : <span className="text-white font-medium">{value}</span>}</div>;
}

function BadgePill({ label, value, tone }: { label: string; value: string; tone: "sky" | "violet" | "emerald" | "amber" | "red" }) {
  const tones: Record<string, string> = {
    sky: "border-[color-mix(in_srgb,var(--theme-primary)_25%,transparent)] bg-sky-400/10 text-sky-200",
    violet: "border-violet-400/25 bg-violet-400/10 text-violet-200",
    emerald: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    amber: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    red: "border-red-400/25 bg-red-400/10 text-red-200",
  };
  return <div className={`rounded-2xl border px-3 py-2 min-w-[118px] font-sans shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${tones[tone] || tones.sky}`}><div className="text-[10px] font-medium uppercase tracking-[0.14em] opacity-70">{label}</div><div className="mt-1 text-sm font-semibold tracking-normal text-white">{value}</div></div>;
}

function MiniPulseCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 font-sans"><div className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/35">{label}</div><div className="mt-1 text-lg font-semibold tracking-[-0.02em] text-white">{value}</div><div className="mt-1 text-[11px] text-white/35">{hint}</div></div>;
}

function RiskBadge({ risk, score }: { risk: "low" | "medium" | "high"; score: number }) {
  const cls = risk === "high" ? "border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] text-[color:var(--theme-danger)]" : risk === "medium" ? "border-[color-mix(in_srgb,var(--theme-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)] text-[color:var(--theme-warning)]" : "border-[color-mix(in_srgb,var(--theme-success)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-success)_10%,transparent)] text-[color:var(--theme-success)]";
  return <div className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold ${cls}`}><Bot className="w-3.5 h-3.5" />{risk} {score}/100</div>;
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}вЂ¦${value.slice(-6)}` : value;
}

const ACCENT_CLASSES: Record<string, { border: string; icon: string; tag: string }> = {
  blue:   { border: "border-blue-400/20 bg-blue-500/5",   icon: "text-blue-300",   tag: "bg-blue-500/10 text-blue-300" },
  yellow: { border: "border-yellow-400/20 bg-[color-mix(in_srgb,var(--theme-warning)_5%,transparent)]", icon: "text-[color:var(--theme-warning)]", tag: "bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)] text-[color:var(--theme-warning)]" },
  purple: { border: "border-purple-400/20 bg-purple-500/5", icon: "text-[color:var(--theme-secondary)]", tag: "bg-purple-500/10 text-[color:var(--theme-secondary)]" },
};

function TrendColumn({
  title, subtitle, icon, items, accent, noDataText,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: TrendItem[];
  accent: string;
  noDataText?: string;
}) {
  const ac = ACCENT_CLASSES[accent] || ACCENT_CLASSES.blue;
  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${ac.border}`}>
      <div>
        <div className="flex items-center gap-2 font-bold text-white text-sm">{icon}{title}</div>
        <div className="text-[10px] text-white/40 mt-0.5">{subtitle}</div>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-white/40">{noDataText || "РќРµС‚ РґР°РЅРЅС‹С…."}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, idx) => (
            <li key={idx} className="group">
              <a href={item.url} target="_blank" rel="noreferrer" className="block rounded-xl border border-transparent hover:border-white/10 hover:bg-white/5 px-2 py-2 transition">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 text-[10px] text-white/25 pt-[3px] w-4 text-right">{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white/80 line-clamp-2 leading-snug">{item.title}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-white/35 truncate">{item.source}</span>
                      {item.tickers.slice(0, 2).map((ticker) => (
                        <span key={ticker} className={`rounded px-1 py-0.5 text-[9px] font-semibold ${ac.tag}`}>${ticker}</span>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <ExternalLink className="w-3 h-3 text-white/20 group-hover:text-white/50 transition" />
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HotPills({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; count: number }>;
}) {
  return (
    <div className="rounded-2xl border border-bg-border bg-white/[0.03] p-4">
      <div className="text-xs font-semibold text-white/60 mb-3">{title}</div>
      <div className="flex flex-wrap gap-2">
        {items.length === 0 ? (
          <span className="text-xs text-white/30">вЂ”</span>
        ) : (
          items.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/70">
              {item.label}
              <span className="text-[10px] text-white/35">{item.count > 1 ? `Г—${item.count}` : ""}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function fmtChange(value: number | null): React.ReactNode {
  if (value === null) return <span className="text-white/30">вЂ”</span>;
  const pos = value >= 0;
  const cls = pos ? "text-[color:var(--theme-success)]" : "text-[color:var(--theme-danger)]";
  const Icon = pos ? ArrowUpRight : ArrowDownRight;
  return <span className={`inline-flex items-center gap-0.5 font-semibold ${cls}`}><Icon className="w-3 h-3" />{Math.abs(value).toFixed(1)}%</span>;
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function FearGauge({ data }: { data: FearGreedData }) {
  const pct = data.value;
  const color = pct >= 75 ? "text-[color:var(--theme-success)]" : pct >= 55 ? "text-[color:var(--theme-success)]" : pct >= 45 ? "text-[color:var(--theme-warning)]" : pct >= 25 ? "text-[color:var(--theme-warning)]" : "text-[color:var(--theme-danger)]";
  const barColor = pct >= 75 ? "bg-[color:var(--theme-success)]" : pct >= 55 ? "bg-lime-400" : pct >= 45 ? "bg-yellow-400" : pct >= 25 ? "bg-orange-400" : "bg-red-400";
  return (
    <div className="rounded-2xl border border-bg-border bg-white/[0.03] p-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-white/40">Fear & Greed Index</div>
      <div className={`text-3xl font-black ${color}`}>{pct}</div>
      <div className="text-xs text-white/60">{data.label}</div>
      <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function NarrativeBar({ narratives }: { narratives: MemeCoinNarrative[] }) {
  if (narratives.length === 0) return null;
  const max = narratives[0].momentumScore || 1;
  return (
    <div className="rounded-2xl border border-yellow-400/20 bg-[color-mix(in_srgb,var(--theme-warning)_5%,transparent)] p-4 space-y-2">
      <div className="text-xs font-bold text-white flex items-center gap-2"><TrendingUp className="w-4 h-4 text-[color:var(--theme-warning)]" />РќР°СЂСЂР°С‚РёРІС‹ РјРµРјРєРѕРёРЅРѕРІ</div>
      <div className="space-y-2">
        {narratives.map((n) => (
          <div key={n.name} className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/80 font-medium">{n.name}</span>
                {n.tokens.slice(0, 3).map((t) => (
                  <span key={t} className="text-[9px] rounded px-1 py-0.5 bg-yellow-500/15 text-[color:var(--theme-warning)]">${t}</span>
                ))}
              </div>
              <span className="text-[10px] text-white/40">{n.momentumScore}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-yellow-400/60" style={{ width: `${(n.momentumScore / max) * 100}%` }} />
            </div>
            {n.description && <div className="text-[10px] text-white/30">{n.description}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function MemeTokenTable({
  tokens,
  title,
  icon,
  twitterState,
  onSelectToken,
}: {
  tokens: MemeCoinToken[];
  title: string;
  icon: React.ReactNode;
  twitterState: MemeTwitterState;
  onSelectToken: (token: MemeCoinToken) => void;
}) {
  if (tokens.length === 0) return null;
  return (
    <div className="rounded-2xl border border-bg-border bg-white/[0.03] overflow-hidden">
      <div className="px-4 py-3 border-b border-bg-border flex items-center gap-2">
        {icon}
        <span className="text-sm font-bold text-white">{title}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-white/5 text-white/35">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">РўРѕРєРµРЅ</th>
              <th className="px-3 py-2 text-right">1h</th>
              <th className="px-3 py-2 text-right">24h</th>
              <th className="px-3 py-2 text-right">Vol 24h</th>
              <th className="px-3 py-2 text-right">Liquidity</th>
              <th className="px-3 py-2 text-right">Txns</th>
              <th className="px-3 py-2 text-center">Hype</th>
              <th className="px-3 py-2 text-left">РќР°СЂСЂР°С‚РёРІ</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const selected = twitterState.selectedMint === t.mint;
              const twitterData = twitterState.dataByMint[t.mint];
              const twitterError = twitterState.errorByMint[t.mint] || null;
              const twitterLoading = twitterState.loadingMint === t.mint;
              return (
                <>
                  <tr
                    key={t.mint}
                    onClick={() => onSelectToken(t)}
                    className={`border-t border-bg-border hover:bg-white/5 transition-colors cursor-pointer ${selected ? "bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)]" : ""}`}
                  >
                    <td className="px-3 py-2 text-white/30">{t.rank}</td>
                    <td className="px-3 py-2">
                      <a
                        href={t.dexUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1.5 group"
                      >
                        <div>
                          <div className="font-bold text-[color:var(--theme-primary)] group-hover:text-[color:var(--theme-primary)]">${t.symbol}</div>
                          <div className="text-[10px] text-white/35 truncate max-w-[80px]">{t.name}</div>
                        </div>
                        <ExternalLink className="w-2.5 h-2.5 text-white/20 group-hover:text-white/50" />
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right">{fmtChange(t.change1h)}</td>
                    <td className="px-3 py-2 text-right">{fmtChange(t.change24h)}</td>
                    <td className="px-3 py-2 text-right text-white/70">{fmtVol(t.volumeUsd24h)}</td>
                    <td className="px-3 py-2 text-right text-white/50">{fmtVol(t.liquidityUsd)}</td>
                    <td className="px-3 py-2 text-right text-white/50">{t.txns24h ? fmt(t.txns24h) : "вЂ”"}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-[10px] font-bold ${t.hypeScore >= 70 ? "bg-red-500/20 text-[color:var(--theme-danger)]" : t.hypeScore >= 40 ? "bg-yellow-500/20 text-[color:var(--theme-warning)]" : "bg-white/10 text-white/40"}`}>
                        {t.hypeScore}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {t.narrative.slice(0, 2).map((n) => (
                          <span key={n} className="text-[9px] rounded px-1 py-0.5 bg-purple-500/15 text-[color:var(--theme-secondary)]">{n}</span>
                        ))}
                        {t.narrative.length === 0 && <span className="text-[10px] text-white/25">вЂ”</span>}
                      </div>
                    </td>
                  </tr>
                  {selected && (
                    <tr key={`${t.mint}-twitter`} className="border-t border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--theme-primary)_5%,transparent)]">
                      <td colSpan={9} className="px-3 py-3">
                        <MemeTokenTwitterPanel token={t} data={twitterData} loading={twitterLoading} error={twitterError} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MemeCoinDeepDive({ meme }: { meme: XTrendsResponse["memecoins"] }) {
  const momentumCls = meme.momentumShift === "bullish" ? "text-[color:var(--theme-success)] border-[color-mix(in_srgb,var(--theme-success)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-success)_10%,transparent)]" : meme.momentumShift === "bearish" ? "text-[color:var(--theme-danger)] border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)]" : "text-[color:var(--theme-warning)] border-[color-mix(in_srgb,var(--theme-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)]";
  const [activeTab, setActiveTab] = useState<"solana" | "gainers" | "volume">("solana");
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [loadingMint, setLoadingMint] = useState<string | null>(null);
  const [twitterByMint, setTwitterByMint] = useState<Record<string, TwitterStats>>({});
  const [twitterErrors, setTwitterErrors] = useState<Record<string, string>>({});
  const MAX_TWITTER_CACHE = 8;
  const tabTokens = activeTab === "solana" ? meme.solanaMemes : activeTab === "gainers" ? meme.topGainers : meme.topVolume;
  const tabTitle = activeTab === "solana" ? "Solana вЂ” С‚РѕРї С…Р°Р№Рї" : activeTab === "gainers" ? "РўРѕРї РіРµР№РЅРµСЂС‹ 24h" : "РўРѕРї РѕР±СЉС‘Рј 24h";
  const tabIcon = activeTab === "solana" ? <Zap className="w-4 h-4 text-[color:var(--theme-secondary)]" /> : activeTab === "gainers" ? <ArrowUpRight className="w-4 h-4 text-green-300" /> : <Activity className="w-4 h-4 text-[color:var(--theme-primary)]" />;
  const twitterState: MemeTwitterState = {
    selectedMint,
    loadingMint,
    errorByMint: twitterErrors,
    dataByMint: twitterByMint,
  };

  async function selectTokenForTwitter(token: MemeCoinToken) {
    if (selectedMint === token.mint) {
      setSelectedMint(null);
      return;
    }
    setSelectedMint(token.mint);
    if (twitterByMint[token.mint] || loadingMint === token.mint) return;
    setLoadingMint(token.mint);
    setTwitterErrors((prev) => ({ ...prev, [token.mint]: "" }));
    try {
      const params = new URLSearchParams({
        mint: token.mint,
        symbol: token.symbol,
        strategy: "auto",
        scope: "official",
      });
      const response = await fetch(`/api/trade/dev-twitter?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setTwitterByMint((prev) => {
        const next = { ...prev, [token.mint]: payload };
        const keys = Object.keys(next);
        if (keys.length <= MAX_TWITTER_CACHE) return next;

        const keep = keys
          .filter((key) => key !== token.mint)
          .slice(Math.max(0, keys.length - MAX_TWITTER_CACHE + 1));
        const trimmed: Record<string, TwitterStats> = { [token.mint]: payload };
        for (const key of keep) {
          const entry = next[key];
          if (entry) trimmed[key] = entry;
        }
        return trimmed;
      });
    } catch (e) {
      setTwitterErrors((prev) => ({ ...prev, [token.mint]: (e as Error).message }));
    } finally {
      setLoadingMint((current) => current === token.mint ? null : current);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-base font-bold text-white"><Coins className="w-5 h-5 text-[color:var(--theme-warning)]" />РњРµРјРєРѕРёРЅС‹ вЂ” РіР»СѓР±РѕРєРёР№ Р°РЅР°Р»РёР·</div>
          <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${momentumCls}`}>
            {meme.momentumShift === "bullish" ? <ArrowUpRight className="w-3 h-3" /> : meme.momentumShift === "bearish" ? <ArrowDownRight className="w-3 h-3" /> : <Activity className="w-3 h-3" />}
            {meme.momentumShift}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/50">
          <span>РћР±С‰РёР№ РѕР±СЉС‘Рј 24h:</span><span className="text-white font-bold">{fmtVol(meme.totalMemeVolume24h)}</span>
          {meme.dominantNarrative && <><span>В·</span><span className="text-[color:var(--theme-warning)]">{meme.dominantNarrative}</span></>}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-3">
          <div className="flex gap-2">
            {(["solana", "gainers", "volume"] as const).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${activeTab === tab ? "border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)] bg-[color-mix(in_srgb,var(--theme-primary)_15%,transparent)] text-[color:var(--theme-primary)]" : "border-white/10 text-white/40 hover:text-white"}`}>
                {tab === "solana" ? "Solana Hype" : tab === "gainers" ? "Gainers" : "Volume"}
              </button>
            ))}
          </div>
          <MemeTokenTable
            tokens={tabTokens}
            title={tabTitle}
            icon={tabIcon}
            twitterState={twitterState}
            onSelectToken={selectTokenForTwitter}
          />
        </div>

        <div className="space-y-3">
          {meme.fearGreed && <FearGauge data={meme.fearGreed} />}
          <NarrativeBar narratives={meme.narratives} />
        </div>
      </div>
    </div>
  );
}

function MemeTokenTwitterPanel({
  token,
  data,
  loading,
  error,
}: {
  token: MemeCoinToken;
  data?: TwitterStats;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] bg-white/[0.04] px-3 py-3 text-xs text-white/50">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-[color:var(--theme-primary)]" />
        Р—Р°РіСЂСѓР¶Р°СЋ Twitter/X Р°РЅР°Р»РёР· РґР»СЏ ${token.symbol}вЂ¦
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] px-3 py-3 text-xs text-[color:var(--theme-danger)]">
        <AlertTriangle className="w-3.5 h-3.5" />
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-bg-border bg-white/[0.04] px-3 py-3 text-xs text-white/40">
        РќРµС‚ Twitter/X РґР°РЅРЅС‹С….
      </div>
    );
  }

  if (data.totalTweets === 0) {
    return (
      <div className="rounded-xl border border-[color-mix(in_srgb,var(--theme-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-warning)_10%,transparent)] px-3 py-3 text-xs text-[color:var(--theme-warning)]">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span className="font-semibold">Twitter/X Р°РЅР°Р»РёР· РЅРµРґРѕСЃС‚СѓРїРµРЅ</span>
        </div>
        <div className="text-yellow-200/70">
          Nitter РёРЅСЃС‚Р°РЅСЃС‹ РЅРµ СЂР°Р±РѕС‚Р°СЋС‚. Р”Р»СЏ Playwright СЃС‚СЂР°С‚РµРіРёРё С‚СЂРµР±СѓРµС‚СЃСЏ Р°РІС‚РѕСЂРёР·РѕРІР°РЅРЅР°СЏ СЃРµСЃСЃРёСЏ X.
          Р—Р°РїСѓСЃС‚РёС‚Рµ <code className="bg-black/30 px-1.5 py-0.5 rounded">node scripts/x-login.mjs</code> РґР»СЏ РЅР°СЃС‚СЂРѕР№РєРё.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] bg-white/[0.05] p-4 space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <Twitter className="w-4 h-4 text-[color:var(--theme-primary)]" />
            ${token.symbol} вЂ” РїРѕРґСЂРѕР±РЅС‹Р№ Twitter/X Р°РЅР°Р»РёР·
          </div>
          <div className="mt-0.5 text-[10px] text-white/35">
            {data.collectionStrategy} В· {data.performance.cached ? "cache" : `${data.performance.responseTimeMs}ms`}
            {data.twitterHandle ? ` В· @${data.twitterHandle}` : ""}
          </div>
        </div>
        <RiskBadge risk={data.botRisk} score={data.botRiskScore} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <MiniMetric label="Tweets" value={data.totalTweets.toString()} />
        <MiniMetric label="Views" value={fmt(data.totalViews)} />
        <MiniMetric label="Likes" value={fmt(data.totalLikes)} />
        <MiniMetric label="Retweets" value={fmt(data.totalRetweets)} />
        <MiniMetric label="Engagement" value={fmt(data.aggregated.totalEngagement)} />
        <MiniMetric label="Eng. Rate" value={`${(data.aggregated.engagementRate * 100).toFixed(2)}%`} />
        <MiniMetric label="Authors" value={data.uniqueMentioners.toString()} />
        <MiniMetric label="Bot Ratio" value={`${(data.aggregated.botRatio * 100).toFixed(1)}%`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-3">
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-white/40">РўРѕРї С‚РІРёС‚С‹</div>
          {data.topTweets.length === 0 ? (
            <div className="rounded-xl border border-bg-border bg-white/[0.03] px-3 py-2 text-xs text-white/35">РќРµС‚ РЅР°Р№РґРµРЅРЅС‹С… С‚РІРёС‚РѕРІ.</div>
          ) : (
            data.topTweets.slice(0, 3).map((tweet) => (
              <div key={tweet.id} className={`rounded-xl border px-3 py-2 ${tweet.isSuspicious ? "border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_5%,transparent)]" : "border-bg-border bg-white/[0.03]"}`}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <a href={`https://x.com/${tweet.author}`} target="_blank" rel="noreferrer" className="text-xs text-[color:var(--theme-primary)] hover:text-[color:var(--theme-primary)]">@{tweet.author}</a>
                  <div className="flex gap-2 text-[10px] text-white/40">
                    <span>рџ‘Ѓ {fmt(tweet.views)}</span>
                    <span>в™Ґ {fmt(tweet.likes)}</span>
                    <span>в†» {fmt(tweet.retweets)}</span>
                  </div>
                </div>
                <p className="text-xs text-white/70 line-clamp-2">{tweet.text}</p>
                {tweet.isSuspicious && <div className="mt-1 text-[10px] text-[color:var(--theme-danger)]">вљ  suspicious engagement</div>}
              </div>
            ))
          )}
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-white/40">Shillers / accounts</div>
          {data.shillers.length === 0 ? (
            <div className="rounded-xl border border-bg-border bg-white/[0.03] px-3 py-2 text-xs text-white/35">РќРµС‚ Р°РєРєР°СѓРЅС‚РѕРІ.</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-bg-border">
              <table className="w-full text-[11px]">
                <thead className="bg-white/5 text-white/35">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Handle</th>
                    <th className="px-2 py-1.5 text-right">Tweets</th>
                    <th className="px-2 py-1.5 text-right">Eng.</th>
                    <th className="px-2 py-1.5 text-center">Bot</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shillers.slice(0, 5).map((item) => (
                    <tr key={item.handle} className="border-t border-bg-border">
                      <td className="px-2 py-1.5"><a href={`https://x.com/${item.handle}`} target="_blank" rel="noreferrer" className="text-[color:var(--theme-primary)] hover:text-[color:var(--theme-primary)]">@{item.handle}</a></td>
                      <td className="px-2 py-1.5 text-right text-white/60">{item.tweets}</td>
                      <td className="px-2 py-1.5 text-right text-white/60">{fmt(item.totalEngagement)}</td>
                      <td className="px-2 py-1.5 text-center">{item.isBot ? <Bot className="w-3.5 h-3.5 text-[color:var(--theme-danger)] mx-auto" /> : <CheckCircle className="w-3.5 h-3.5 text-[color:var(--theme-success)] mx-auto" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-white/35">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-white">{value}</div>
    </div>
  );
}


