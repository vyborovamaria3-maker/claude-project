import { closeLive } from "../lib/collector/live";
import { handleCollectorRequest } from "../lib/collector/http";
import { stopManagedWorker } from "../lib/collector/runtime";
import http from "node:http";
import { handleArchiveRequest } from "../lib/archive/http";
import { handleReplyRequest } from "../lib/reply/http";
import fs from "node:fs/promises";
import path from "node:path";
import { q } from "../lib/trade/pg";
import { log, closeLogger } from "../lib/trade/logger";
import { isLoopbackHost, enforceBasicAuth } from "../lib/trade/http-auth";
import { SolanaMint, Handle } from "../lib/trade/schemas";
import { intParam } from "../lib/trade/num";
import {
  applySecurityHeaders, checkOrigin, createRateLimiter, clientIp, dashboardRequestOrigin,
} from "../lib/trade/http-security";
import { httpRequests, httpRequestDuration } from "../lib/trade/metrics";
import {
  getDailyDigest, getTopShillers, getRisingAuthors, getTrendingWords,
  getCashtagTrends, getCoordinatedAccounts, getMintOverlap,
  getWorkerEfficiency, getAccountHealth, getMintSummary, getMintDailyFunnel,
  getMintBursts, getTopTweetsForMint, getMintTimeseries, getMintFullReport,
} from "../lib/trade/analytics";
import { queueStats, dlqStats } from "../lib/trade/tasks";
import { getSentimentByMint, getSentimentByAuthor, getMintSentimentDaily } from "../lib/trade/analytics-nlp";
import {
  listMintEvents, listMintMilestones, getFirstMovers, getMintTimeline, getMintFirstVerified,
} from "../lib/trade/analytics-events";
import { getAuthorReputation, getTopKOLs, getSuspiciousAuthors, getAuthorBehavior, getKOLsForMint } from "../lib/trade/analytics-kol";
import { listClusters, getClusterMembers, getAuthorCluster } from "../lib/trade/analytics-clusters";
import { getMintMetrics, getMintAnomalies, getMintTrend } from "../lib/trade/analytics-timeseries";
import {
  getTopHype, getHypeRisers, getHypeFallers, getEarlySignals,
  getSimilarMints, getLeadAuthors, getWeightedSentiment,
  getTopWeightedSentiment, getTopPageRank, listBacktests, getBacktestTrades, rebuildHypeScores,
  rebuildUltraScores,
} from "../lib/trade/analytics-advanced";
import {
  buildTrainingData, trainModel, listModels, predictMint,
  getCrossMintSignals, getSentimentDivergence, getTopUltra,
} from "../lib/trade/analytics-predictive";

const PORT = Number(process.env.DASHBOARD_PORT ?? 3001);
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASS = process.env.DASHBOARD_PASS;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN;
const RATE_LIMIT = Number(process.env.DASHBOARD_RATE_LIMIT ?? 120);
if (Boolean(AUTH_USER) !== Boolean(AUTH_PASS)) {
  throw new Error("DASHBOARD_USER and DASHBOARD_PASS must be set together");
}
if (!isLoopbackHost(HOST) && (!AUTH_USER || !AUTH_PASS)) {
  throw new Error("Dashboard auth is required when binding to a non-loopback host");
}
if (!isLoopbackHost(HOST) && !DASHBOARD_ORIGIN) {
  throw new Error("DASHBOARD_ORIGIN is required when binding to a non-loopback host");
}
const MUTATING_ROUTES = new Set(["/api/hype/rebuild", "/api/ultra/rebuild", "/api/ml/train"]);
const allowRequest = createRateLimiter(RATE_LIMIT);

const limitParam = (url: URL, def = 50, max = 1000) =>
  intParam(url.searchParams.get("limit"), def, 1, max);
const daysParam = (url: URL, def = 30) =>
  intParam(url.searchParams.get("days"), def, 1, 3650);

type Handler = (req: { url: URL; method: string }) => Promise<unknown>;
const routes: Record<string, Handler> = {
  "/api/health": async () => { await q(`SELECT 1`); return { ok: true, ts: Date.now() }; },
  "/api/digest": async (req) => getDailyDigest(req.url.searchParams.get("day") ?? undefined),
  "/api/tasks": async () => ({ queue: await queueStats(), dlq: (await dlqStats())?.n ?? 0 }),
  "/api/workers": async () => getWorkerEfficiency(),
  "/api/accounts": async () => getAccountHealth(),
  "/api/shillers": async (req) => getTopShillers(limitParam(req.url)),
  "/api/rising": async (req) => getRisingAuthors(limitParam(req.url, 30)),
  "/api/trending": async (req) => getTrendingWords(limitParam(req.url)),
  "/api/cashtags": async (req) => getCashtagTrends(limitParam(req.url)),
  "/api/coordinated": async (req) => getCoordinatedAccounts(limitParam(req.url)),
  "/api/overlap": async (req) => getMintOverlap(5, limitParam(req.url)),
  "/api/mint/summary": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintSummary(mint);
  },
  "/api/mint/funnel": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintDailyFunnel(mint, daysParam(req.url));
  },
  "/api/mint/bursts": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintBursts(mint, 20);
  },
  "/api/mint/timeseries": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintTimeseries(mint, intParam(req.url.searchParams.get("interval"), 3600000, 60000, 604800000));
  },
  "/api/mint/tweets": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getTopTweetsForMint(mint, limitParam(req.url, 20));
  },
  "/api/mint/full": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintFullReport(mint, 30);
  },
  "/api/sentiment/mint": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return { summary: await getSentimentByMint(mint), daily: await getMintSentimentDaily(mint, 30) };
  },
  "/api/sentiment/author": async (req) => {
    const h = req.url.searchParams.get("handle");
    if (!h) throw new Error("handle required");
    return getSentimentByAuthor(h);
  },
  "/api/mint/events": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return {
      events: await listMintEvents(mint, 50),
      milestones: await listMintMilestones(mint),
      timeline: await getMintTimeline(mint, 50),
      firstMovers: await getFirstMovers(mint),
      firstVerified: await getMintFirstVerified(mint),
    };
  },
  "/api/kol/top": async (req) => getTopKOLs(limitParam(req.url), 60),
  "/api/kol/suspicious": async (req) => getSuspiciousAuthors(limitParam(req.url, 100)),
  "/api/kol/mint": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getKOLsForMint(mint, 50);
  },
  "/api/author/reputation": async (req) => {
    const h = req.url.searchParams.get("handle");
    if (!h) throw new Error("handle required");
    return {
      reputation: await getAuthorReputation(h),
      behavior: await getAuthorBehavior(h),
      cluster: await getAuthorCluster(h),
    };
  },
  "/api/clusters": async (req) => listClusters(intParam(req.url.searchParams.get("min-size"), 3, 1, 1000)),
  "/api/cluster/members": async (req) => getClusterMembers(intParam(req.url.searchParams.get("id"), 1, 1, 2147483647)),
  "/api/timeseries/mint": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    const rawGranularity = req.url.searchParams.get("granularity") ?? "1h";
    if (!["1m", "1h", "1d", "1w"].includes(rawGranularity)) {
      throw new Error("granularity must be one of: 1m, 1h, 1d, 1w");
    }
    return getMintMetrics(mint, rawGranularity as "1m" | "1h" | "1d" | "1w", undefined, 1000);
  },
  "/api/timeseries/trend": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintTrend(mint, intParam(req.url.searchParams.get("hours"), 24, 1, 8760));
  },
  "/api/anomalies": async (req) => getMintAnomalies(
    req.url.searchParams.get("mint") ?? undefined,
    limitParam(req.url, 100)
  ),
  "/api/hype/top": async (req) => getTopHype(limitParam(req.url, 30), 40),
  "/api/hype/risers": async (req) => getHypeRisers(limitParam(req.url, 30)),
  "/api/hype/fallers": async (req) => getHypeFallers(limitParam(req.url, 30)),
  "/api/hype/rebuild": async () => ({ rebuilt: await rebuildHypeScores() }),
  "/api/signals": async (req) => getEarlySignals(
    limitParam(req.url, 30),
    intParam(req.url.searchParams.get("min-strength"), 30, 0, 100)
  ),
  "/api/similar": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getSimilarMints(mint, limitParam(req.url, 20));
  },
  "/api/leaders": async (req) => getLeadAuthors(limitParam(req.url, 50)),
  "/api/sentiment/weighted": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (mint) return getWeightedSentiment(mint);
    return getTopWeightedSentiment(limitParam(req.url, 30));
  },
  "/api/pagerank": async (req) => getTopPageRank(limitParam(req.url, 50)),
  "/api/backtest/list": async () => listBacktests(20),
  "/api/backtest/trades": async (req) => getBacktestTrades(intParam(req.url.searchParams.get("id"), 1, 1, 2147483647), 200),
  "/api/ultra/top": async (req) => getTopUltra(limitParam(req.url, 30)),
  "/api/ultra/rebuild": async () => ({ rebuilt: await rebuildUltraScores() }),
  "/api/cross-mint": async (req) => getCrossMintSignals(limitParam(req.url, 30)),
  "/api/divergence": async (req) => getSentimentDivergence(limitParam(req.url, 30)),
  "/api/ml/models": async () => listModels(20),
  "/api/ml/predict": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return predictMint(mint, intParam(req.url.searchParams.get("horizon"), 6, 1, 720));
  },
  "/api/ml/train": async (req) => {
    const horizon = intParam(req.url.searchParams.get("horizon"), 6, 1, 720);
    await buildTrainingData(horizon, 12);
    const modelId = await trainModel(`manual-h${horizon}-${Date.now()}`, horizon);
    return { modelId };
  },
  "/api/recent-mints": async (req) => q(
    `SELECT mint, total_tweets, unique_authors, total_views, last_mention_at
     FROM v_mint_summary ORDER BY last_mention_at DESC LIMIT $1`,
    [limitParam(req.url, 30)]
  ),
  "/api/recent-tweets": async (req) => q(
    `SELECT tweet_id, handle, text, url, views, likes, retweets, posted_at
     FROM twitter_tweets ORDER BY first_seen_at DESC LIMIT $1`,
    [limitParam(req.url, 50)]
  ),
};

export const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Solana X Collector</title>
<script src="/assets/vue.js"></script>
<script src="/assets/chart.js"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; }
  header { background: #161b22; padding: 12px 24px; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 24px; position: sticky; top: 0; z-index: 10; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 18px; color: #58a6ff; }
  nav { display: flex; gap: 8px; flex-wrap: wrap; }
  nav button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  nav button.active { background: #1f6feb; border-color: #1f6feb; color: white; }
  nav button:hover:not(.active) { background: #30363d; }
  main { padding: 24px; max-width: 1600px; margin: 0 auto; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 12px 0; font-size: 15px; color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px; border-bottom: 1px solid #30363d; color: #8b949e; font-weight: normal; }
  td { padding: 8px; border-bottom: 1px solid #21262d; }
  tr:hover { background: #1c2128; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .badge.verified { background: #1f6feb33; color: #58a6ff; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat { background: #21262d; border-radius: 8px; padding: 14px; }
  .stat .label { font-size: 11px; color: #8b949e; text-transform: uppercase; }
  .stat .value { font-size: 24px; font-weight: 600; color: #58a6ff; margin-top: 4px; }
  input, select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
  button.primary { background: #1f6feb; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
  .row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .error { color: #f85149; padding: 12px; background: #f8514922; border-radius: 6px; }
  .tweet-text { color: #8b949e; font-size: 12px; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a { color: #58a6ff; text-decoration: none; }
  .chart-container { position: relative; height: 300px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>🔍 X Collector</h1>
    <nav>
      <a href="/collector" style="padding:8px;color:#58a6ff">Начать парсинг</a>
      <a href="/archive" style="padding:8px;color:#58a6ff">Archive</a>
      <a href="/reply" style="padding:8px;color:#58a6ff">Reply Guy</a>
      <button v-for="t in tabs" :key="t.id" @click="active = t.id" :class="{active: active === t.id}">{{ t.label }}</button>
    </nav>
  </header>
  <main>
    <div class="card"><button @click="refresh" :disabled="loading">{{ loading ? 'Загрузка…' : 'Обновить' }}</button>
      <p v-if="lastUpdated">Последняя попытка обновления: {{ lastUpdated }}</p>
      <p v-for="(message, endpoint) in errors" :key="endpoint" class="error">{{ endpoint }}: {{ message }}</p>
    </div>
    <div v-if="active === 'overview'">
      <div class="stats" style="margin-bottom: 16px;">
        <div class="stat" v-for="s in digest" :key="s.metric">
          <div class="label">{{ s.metric }}</div>
          <div class="value">{{ s.value }}</div>
        </div>
      </div>
      <div class="card">
        <h2>Очередь</h2>
        <table><tr><th>Status</th><th>Kind</th><th class="num">Кол-во</th></tr>
        <tr v-for="t in tasks.queue" :key="t.status + t.kind"><td>{{t.status}}</td><td>{{t.kind}}</td><td class="num">{{t.n}}</td></tr></table>
        <p style="margin-top:12px;">DLQ: <strong>{{ tasks.dlq }}</strong></p>
      </div>
    </div>

    <div v-if="active === 'mint'">
      <div class="card">
        <div class="row">
          <input v-model="mintInput" placeholder="Mint address..." style="flex:1; min-width: 300px;"/>
          <button class="primary" @click="loadMint">Загрузить</button>
        </div>
        <div v-if="mintError" class="error">{{ mintError }}</div>
      </div>
      <template v-if="mintFull">
        <div class="card" v-if="mintFull.summary">
          <h2>Summary</h2>
          <div class="stats">
            <div class="stat"><div class="label">Твитов</div><div class="value">{{ mintFull.summary.total_tweets }}</div></div>
            <div class="stat"><div class="label">Авторов</div><div class="value">{{ mintFull.summary.unique_authors }}</div></div>
            <div class="stat"><div class="label">Views</div><div class="value">{{ fmtNum(mintFull.summary.total_views) }}</div></div>
          </div>
        </div>
        <div class="card"><h2>Time-series</h2><div class="chart-container"><canvas ref="mintChart"></canvas></div></div>
        <div class="card" v-if="mintFull.topAuthors && mintFull.topAuthors.length">
          <h2>Топ авторов</h2>
          <table><tr><th>Handle</th><th class="num">Твитов</th><th class="num">Views</th></tr>
          <tr v-for="a in mintFull.topAuthors" :key="a.handle">
            <td><a :href="'https://x.com/' + a.handle" target="_blank">@{{ a.handle }}</a></td>
            <td class="num">{{ a.tweets_count }}</td><td class="num">{{ fmtNum(a.total_views) }}</td>
          </tr></table>
        </div>
        <div class="card"><h2>Собранные посты</h2><p v-if="!mintFull.topTweets || !mintFull.topTweets.length">Нет собранных постов</p>
          <table><tr><th>Автор</th><th>Текст</th><th class="num">Views</th></tr>
          <tr v-for="tweet in mintFull.topTweets" :key="tweet.tweet_id"><td>@{{ tweet.handle }}</td><td>{{ tweet.text }}</td><td class="num">{{ fmtNum(tweet.views) }}</td></tr></table>
        </div>
        <div class="card"><h2>Всплески активности</h2><p v-if="!mintFull.bursts || !mintFull.bursts.length">Нет данных о всплесках</p>
          <table><tr><th>Время</th><th class="num">Твиты</th><th class="num">Рост</th></tr>
          <tr v-for="burst in mintFull.bursts" :key="burst.hour_start_ms"><td>{{ new Date(Number(burst.hour_start_ms)).toLocaleString() }}</td><td class="num">{{ burst.tweets }}</td><td class="num">{{ burst.growth_x }}</td></tr></table>
        </div>
      </template>
    </div>

    <div v-if="active === 'hype'">
      <div class="card"><h2>Топ по hype score</h2>
        <table><tr><th>Mint</th><th class="num">Score</th><th class="num">Δ1h</th></tr>
        <tr v-for="h in hype" :key="h.mint"><td>{{ shortMint(h.mint) }}</td><td class="num">{{ h.hype_score }}</td><td class="num">{{ h.delta_1h }}</td></tr></table>
      </div>
      <div class="card"><h2>Ранние сигналы</h2>
        <table><tr><th>Mint</th><th class="num">Strength</th><th class="num">30m tweets</th></tr>
        <tr v-for="s in signals" :key="s.mint"><td>{{ shortMint(s.mint) }}</td><td class="num">{{ s.signal_strength }}</td><td class="num">{{ s.last_30m }}</td></tr></table>
      </div>
    </div>

    <div v-if="active === 'ultra'">
      <div class="card"><h2>Ultra Score</h2>
        <table><tr><th>Mint</th><th class="num">Ultra</th><th class="num">Hype</th><th class="num">P(views набора +50%)</th></tr>
        <tr v-for="u in ultra" :key="u.mint"><td>{{ shortMint(u.mint) }}</td><td class="num">{{ u.ultra_score }}</td><td class="num">{{ u.hype }}</td><td class="num">{{ u.views_growth_50_probability ?? 'Нет модели' }}</td></tr></table>
      </div>
    </div>

    <div v-if="active === 'shillers'">
      <div class="card"><h2>Топ шиллеров</h2>
        <table><tr><th>Handle</th><th class="num">Монет</th><th class="num">Views</th></tr>
        <tr v-for="s in shillers" :key="s.handle">
          <td><a :href="'https://x.com/' + s.handle" target="_blank">@{{ s.handle }}</a></td>
          <td class="num">{{ s.mints_promoted }}</td><td class="num">{{ fmtNum(s.total_views) }}</td>
        </tr></table>
      </div>
    </div>

    <div v-if="active === 'trending'">
      <div class="card"><h2>Популярные слова</h2>
        <p v-if="!trending.length">Нет собранных данных</p>
        <table><tr><th>Слово</th><th class="num">Упоминаний</th><th class="num">Авторов</th></tr>
        <tr v-for="word in trending" :key="word.word"><td>{{ word.word }}</td><td class="num">{{ word.occurrences }}</td><td class="num">{{ word.authors }}</td></tr></table>
      </div>
      <div class="card"><h2>Cashtag-тренды</h2>
        <table><tr><th>Tag</th><th class="num">Упоминаний</th></tr>
        <tr v-for="c in cashtags" :key="c.tag"><td>&#36;{{ c.tag }}</td><td class="num">{{ c.mentions }}</td></tr></table>
      </div>
    </div>

    <div v-if="active === 'leaders'">
      <div class="card"><h2>Lead authors</h2>
        <table><tr><th>Handle</th><th class="num">Lead ratio</th><th class="num">Стартов</th></tr>
        <tr v-for="l in leaders" :key="l.handle">
          <td><a :href="'https://x.com/' + l.handle" target="_blank">@{{ l.handle }}</a></td>
          <td class="num">{{ l.lead_ratio }}</td><td class="num">{{ l.mint_starts }}</td>
        </tr></table>
      </div>
      <div class="card"><h2>PageRank</h2>
        <table><tr><th>Handle</th><th class="num">PR</th><th class="num">In</th><th class="num">Out</th></tr>
        <tr v-for="p in pagerank" :key="p.handle">
          <td>@{{ p.handle }}</td><td class="num">{{ Number(p.pagerank).toFixed(6) }}</td>
          <td class="num">{{ p.degree_in }}</td><td class="num">{{ p.degree_out }}</td>
        </tr></table>
      </div>
    </div>

    <div v-if="active === 'system'">
      <div class="card"><h2>Воркеры</h2>
        <table><tr><th>ID</th><th>Status</th><th class="num">Done</th><th class="num">Failed</th></tr>
        <tr v-for="w in workers" :key="w.id"><td>{{ w.id }}</td><td>{{ w.status }}</td><td class="num">{{ w.tasks_done }}</td><td class="num">{{ w.tasks_failed }}</td></tr></table>
      </div>
      <div class="card"><h2>Аккаунты X</h2>
        <table><tr><th>Name</th><th>Tier</th><th>Status</th><th class="num">Err %</th><th class="num">Quota %</th></tr>
        <tr v-for="a in accounts" :key="a.name"><td>{{ a.name }}</td><td>{{ a.tier }}</td><td>{{ a.status }}</td><td class="num">{{ a.error_rate_pct }}</td><td class="num">{{ a.quota_used_pct }}</td></tr></table>
      </div>
    </div>
  </main>
</div>
<script>
const { createApp, ref, onMounted, onUnmounted, nextTick, watch } = Vue;
createApp({
  setup() {
    const tabs = [
      { id: 'overview', label: 'Overview' }, { id: 'mint', label: 'Mint' },
      { id: 'hype', label: 'Hype' }, { id: 'ultra', label: 'Ultra' },
      { id: 'shillers', label: 'Shillers' }, { id: 'trending', label: 'Trending' },
      { id: 'leaders', label: 'Leaders' }, { id: 'system', label: 'System' },
    ];
    const active = ref(tabs.some(t => t.id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
    const errors = ref({}); const loading = ref(false); const lastUpdated = ref('');
    let timer; let mintRequest = 0;
    function hashChanged() { const id = location.hash.slice(1); if (tabs.some(t => t.id === id)) active.value = id; }
    watch(active, async id => { location.hash = id; if (id !== 'mint' && mintChartInstance) { mintChartInstance.destroy(); mintChartInstance = null; } await nextTick(); if (id === 'mint') drawMint(); });
    const digest = ref([]); const tasks = ref({ queue: [], dlq: 0 });
    const shillers = ref([]); const cashtags = ref([]); const trending = ref([]);
    const workers = ref([]); const accounts = ref([]);
    const hype = ref([]); const signals = ref([]); const ultra = ref([]);
    const leaders = ref([]); const pagerank = ref([]);
    const mintInput = ref(''); const mintFull = ref(null); const mintError = ref('');
    const mintChart = ref(null);
    let mintChartInstance = null;

    async function api(path) {
      const r = await fetch(path, { signal: AbortSignal.timeout(65000) });
      if (!r.ok) { let message = 'HTTP ' + r.status; try { message += ': ' + (await r.json()).error; } catch {} throw new Error(message); }
      return r.json();
    }
    function fmtNum(n) {
      if (n === null || n === undefined) return '—';
      const v = Number(n); if (!isFinite(v)) return n;
      if (v >= 1e9) return (v/1e9).toFixed(2)+'B';
      if (v >= 1e6) return (v/1e6).toFixed(2)+'M';
      if (v >= 1e3) return (v/1e3).toFixed(1)+'K';
      return String(v);
    }
    function shortMint(m) { return m ? m.slice(0,4)+'…'+m.slice(-4) : ''; }

    async function refresh() {
      if (loading.value) return;
      loading.value = true;
      const requests = [
        ['/api/digest', digest], ['/api/tasks', tasks], ['/api/shillers?limit=50', shillers],
        ['/api/cashtags?limit=30', cashtags], ['/api/trending?limit=50', trending], ['/api/workers', workers], ['/api/accounts', accounts],
        ['/api/hype/top?limit=30', hype], ['/api/signals?limit=30', signals],
        ['/api/ultra/top?limit=30', ultra], ['/api/leaders?limit=50', leaders], ['/api/pagerank?limit=50', pagerank],
      ];
      await Promise.allSettled(requests.map(async ([endpoint, target]) => {
        try { target.value = await api(endpoint); delete errors.value[endpoint]; }
        catch (e) { errors.value[endpoint] = e.message || String(e); }
      }));
      lastUpdated.value = new Date().toLocaleTimeString(); loading.value = false;
    }
    function drawMint() {
      if (!mintChart.value || !mintFull.value) return;
      if (mintChartInstance) mintChartInstance.destroy();
      const f = mintFull.value.dailyFunnel || [];
      mintChartInstance = new Chart(mintChart.value.getContext('2d'), {
        type: 'line',
        data: { labels: f.map(x => String(x.day).slice(0,10)), datasets: [
          { label: 'Твиты', data: f.map(x => Number(x.tweets)), borderColor: '#58a6ff', tension: 0.3 },
        ]},
        options: { responsive: true, maintainAspectRatio: false,
          scales: { x: { ticks: { color: '#8b949e' } }, y: { ticks: { color: '#8b949e' } } } }
      });
    }
    async function loadMint() {
      const request = ++mintRequest;
      mintError.value = ''; mintFull.value = null;
      if (mintChartInstance) { mintChartInstance.destroy(); mintChartInstance = null; }
      const mint = mintInput.value.trim(); if (!mint) { mintError.value = 'Введите mint address'; return; }
      try {
        const data = await api('/api/mint/full?mint=' + encodeURIComponent(mint));
        if (request !== mintRequest) return;
        mintFull.value = data;
        if (!data.summary) mintError.value = 'Для этого mint нет собранных данных';
        await nextTick(); drawMint();
      } catch (e) { if (request === mintRequest) mintError.value = String(e.message || e); }
    }
    onMounted(() => { location.hash = active.value; refresh(); timer = setInterval(refresh, 30000); addEventListener('hashchange', hashChanged); });
    onUnmounted(() => { clearInterval(timer); removeEventListener('hashchange', hashChanged); if (mintChartInstance) mintChartInstance.destroy(); });
    return { errors, loading, lastUpdated, refresh, tabs, active, digest, tasks, shillers, cashtags, trending, workers, accounts,
      hype, signals, ultra, leaders, pagerank,
      mintInput, mintFull, mintError, mintChart, loadMint, fmtNum, shortMint };
  },
}).mount('#app');
</script>
</body>
</html>`;

export const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const pathname = (() => {
    try { return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname; }
    catch { return "/invalid"; }
  })();

  const finish = (status: number) => {
    httpRequests.inc({ service: "dashboard", route: pathname, status: String(status) });
    httpRequestDuration.observe({ service: "dashboard", route: pathname }, (Date.now() - start) / 1000);
  };

  // Security headers применяются ко всем ответам, включая 401/429.
  applySecurityHeaders(res, { allowUnsafeEval: true });

  if (!allowRequest(clientIp(req))) {
    res.statusCode = 429;
    res.setHeader("Retry-After", "60");
    res.end(JSON.stringify({ error: "too many requests" }));
    finish(429);
    return;
  }

  if (!enforceBasicAuth(req, res, AUTH_USER, AUTH_PASS, "dashboard")) {
    finish(401);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === '/reply' || url.pathname === '/reply.js' || url.pathname.startsWith('/api/reply/')) {
      await handleReplyRequest(req, res);
      finish(res.statusCode);
      return;
    }
    if (await handleCollectorRequest(req,res,dashboardRequestOrigin(req, DASHBOARD_ORIGIN, HOST, PORT))) {finish(res.statusCode);return;}
    if (await handleArchiveRequest(req,res)) { finish(res.statusCode); return; }
    const route = routes[url.pathname];
    const mutating = MUTATING_ROUTES.has(url.pathname);
    if (mutating) {
      const origin = checkOrigin(req, dashboardRequestOrigin(req, DASHBOARD_ORIGIN, HOST, PORT));
      if (!origin.ok) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: origin.reason }));
        finish(403);
        return;
      }
    }
    if (mutating && req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end(JSON.stringify({ error: "POST required" }));
      finish(405);
      return;
    }
    if (!mutating && req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end(JSON.stringify({ error: "method not allowed" }));
      finish(405);
      return;
    }
    const assets: Record<string, string> = {
      '/assets/vue.js': path.join(path.dirname(require.resolve('vue/package.json')), 'dist/vue.global.prod.js'),
      '/assets/chart.js': path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js'),
    };
    if (assets[url.pathname]) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(await fs.readFile(assets[url.pathname]));
      finish(200);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(HTML);
      finish(200);
      return;
    }
    if (route) {
      const mint = url.searchParams.get('mint');
      const handle = url.searchParams.get('handle');
      const mintRequired = url.pathname.startsWith('/api/mint/') || ['/api/sentiment/mint', '/api/kol/mint', '/api/timeseries/mint', '/api/timeseries/trend', '/api/similar', '/api/ml/predict'].includes(url.pathname);
      const handleRequired = ['/api/sentiment/author', '/api/author/reputation'].includes(url.pathname);
      const granularity = url.searchParams.get('granularity');
      if ((mintRequired && !mint) || (mint !== null && !SolanaMint.safeParse(mint).success) ||
          (handleRequired && !handle) || (handle !== null && !Handle.safeParse(handle).success) ||
          (granularity !== null && !['1m', '1h', '1d', '1w'].includes(granularity))) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid or missing mint, handle or granularity' }));
        finish(400);
        return;
      }
      const data = await route({ url, method: req.method ?? "GET" });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
      log.debug("api", { path: url.pathname, ms: Date.now() - start });
      finish(200);
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
    finish(404);
  } catch (e) {
    // Логируем подробности серверу, клиенту отдаём только общий текст.
    const msg = e instanceof Error ? e.message : String(e);
    log.error("dashboard error", { error: msg });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "internal server error" }));
    finish(500);
  }
});

server.on("error", (e) => log.error("dashboard server error", { error: String(e) }));
if (require.main === module) server.listen(PORT, HOST, () => {
  log.info("dashboard listening", { host: HOST, port: PORT, authenticated: Boolean(AUTH_USER && AUTH_PASS) });
  console.log(`\n🌐 Dashboard: http://${HOST}:${PORT}\n`);
});

async function shutdown(signal: string) {
  log.info("shutting down dashboard", { signal });
  closeLive();
  const closed = new Promise<void>(resolve=>server.close(()=>resolve()));
  await stopManagedWorker();
  await closed;
  {
    closeLogger();
    process.exit(0);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

