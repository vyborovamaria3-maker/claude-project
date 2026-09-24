import http from "node:http";
import { q } from "../lib/trade/pg";
import { log } from "../lib/trade/logger";
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
import { getMintMetrics, getMintAnomalies, getMintTrend, getAuthorMetrics } from "../lib/trade/analytics-timeseries";
import {
  getTopHype, getHypeRisers, getHypeFallers, getEarlySignals,
  getSimilarMints, getLeadAuthors, getWeightedSentiment,
  getTopWeightedSentiment, getTopPageRank, listBacktests, getBacktestTrades, rebuildHypeScores,
} from "../lib/trade/analytics-advanced";
import {
  buildTrainingData, trainModel, listModels, predictMint,
  getCrossMintSignals, getSentimentDivergence, getTopUltra,
} from "../lib/trade/analytics-predictive";
import { getAuthorPageRank, rebuildUltraScores } from "../lib/trade/analytics-advanced";

const PORT = Number(process.env.DASHBOARD_PORT ?? 3001);
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASS = process.env.DASHBOARD_PASS;
if (Boolean(AUTH_USER) !== Boolean(AUTH_PASS)) {
  throw new Error("DASHBOARD_USER and DASHBOARD_PASS must be set together");
}
if (HOST !== "127.0.0.1" && HOST !== "::1" && (!AUTH_USER || !AUTH_PASS)) {
  throw new Error("Dashboard auth is required when binding to a non-loopback host");
}
const MUTATING_ROUTES = new Set(["/api/hype/rebuild", "/api/ultra/rebuild", "/api/ml/train"]);

type Handler = (req: { url: URL; method: string }) => Promise<any>;
const routes: Record<string, Handler> = {
  "/api/health": async () => { await q(`SELECT 1`); return { ok: true, ts: Date.now() }; },
  "/api/digest": async (req) => getDailyDigest(req.url.searchParams.get("day") ?? undefined),
  "/api/tasks": async () => ({ queue: await queueStats(), dlq: (await dlqStats())?.n ?? 0 }),
  "/api/workers": async () => getWorkerEfficiency(),
  "/api/accounts": async () => getAccountHealth(),
  "/api/shillers": async (req) => getTopShillers(Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/rising": async (req) => getRisingAuthors(Number(req.url.searchParams.get("limit") ?? 30)),
  "/api/trending": async (req) => getTrendingWords(Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/cashtags": async (req) => getCashtagTrends(Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/coordinated": async (req) => getCoordinatedAccounts(Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/overlap": async (req) => getMintOverlap(5, Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/mint/summary": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintSummary(mint);
  },
  "/api/mint/funnel": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintDailyFunnel(mint, Number(req.url.searchParams.get("days") ?? 30));
  },
  "/api/mint/bursts": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintBursts(mint, 20);
  },
  "/api/mint/timeseries": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getMintTimeseries(mint, Number(req.url.searchParams.get("interval") ?? 3600000));
  },
  "/api/mint/tweets": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getTopTweetsForMint(mint, Number(req.url.searchParams.get("limit") ?? 20));
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
  "/api/kol/top": async (req) => getTopKOLs(Number(req.url.searchParams.get("limit") ?? 50), 60),
  "/api/kol/suspicious": async (req) => getSuspiciousAuthors(Number(req.url.searchParams.get("limit") ?? 100)),
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
  "/api/clusters": async (req) => listClusters(Number(req.url.searchParams.get("min-size") ?? 3)),
  "/api/cluster/members": async (req) => getClusterMembers(Number(req.url.searchParams.get("id"))),
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
    return getMintTrend(mint, Number(req.url.searchParams.get("hours") ?? 24));
  },
  "/api/anomalies": async (req) => getMintAnomalies(
    req.url.searchParams.get("mint") ?? undefined,
    Number(req.url.searchParams.get("limit") ?? 100)
  ),
  "/api/hype/top": async (req) => getTopHype(Number(req.url.searchParams.get("limit") ?? 30), 40),
  "/api/hype/risers": async (req) => getHypeRisers(Number(req.url.searchParams.get("limit") ?? 30)),
  "/api/hype/fallers": async (req) => getHypeFallers(Number(req.url.searchParams.get("limit") ?? 30)),
  "/api/hype/rebuild": async () => ({ rebuilt: await rebuildHypeScores() }),
  "/api/signals": async (req) => getEarlySignals(
    Number(req.url.searchParams.get("limit") ?? 30),
    Number(req.url.searchParams.get("min-strength") ?? 30)
  ),
  "/api/similar": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return getSimilarMints(mint, Number(req.url.searchParams.get("limit") ?? 20));
  },
  "/api/leaders": async (req) => getLeadAuthors(Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/sentiment/weighted": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (mint) return getWeightedSentiment(mint);
    return getTopWeightedSentiment(Number(req.url.searchParams.get("limit") ?? 30));
  },
  "/api/pagerank": async (req) => getTopPageRank(Number(req.url.searchParams.get("limit") ?? 50)),
  "/api/backtest/list": async () => listBacktests(20),
  "/api/backtest/trades": async (req) => getBacktestTrades(Number(req.url.searchParams.get("id")), 200),
  "/api/ultra/top": async (req) => getTopUltra(Number(req.url.searchParams.get("limit") ?? 30)),
  "/api/ultra/rebuild": async () => ({ rebuilt: await rebuildUltraScores() }),
  "/api/cross-mint": async (req) => getCrossMintSignals(Number(req.url.searchParams.get("limit") ?? 30)),
  "/api/divergence": async (req) => getSentimentDivergence(Number(req.url.searchParams.get("limit") ?? 30)),
  "/api/ml/models": async () => listModels(20),
  "/api/ml/predict": async (req) => {
    const mint = req.url.searchParams.get("mint");
    if (!mint) throw new Error("mint required");
    return predictMint(mint, Number(req.url.searchParams.get("horizon") ?? 6));
  },
  "/api/ml/train": async (req) => {
    const horizon = Number(req.url.searchParams.get("horizon") ?? 6);
    await buildTrainingData(horizon, 12);
    const modelId = await trainModel(`manual-h${horizon}-${Date.now()}`, horizon);
    return { modelId };
  },
  "/api/recent-mints": async (req) => q(
    `SELECT mint, total_tweets, unique_authors, total_views, last_mention_at
     FROM v_mint_summary ORDER BY last_mention_at DESC LIMIT $1`,
    [Number(req.url.searchParams.get("limit") ?? 30)]
  ),
  "/api/recent-tweets": async (req) => q(
    `SELECT tweet_id, handle, text, url, views, likes, retweets, posted_at
     FROM twitter_tweets ORDER BY first_seen_at DESC LIMIT $1`,
    [Number(req.url.searchParams.get("limit") ?? 50)]
  ),
};

const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Solana X Collector</title>
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
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
      <button v-for="t in tabs" :key="t.id" @click="active = t.id" :class="{active: active === t.id}">{{ t.label }}</button>
    </nav>
  </header>
  <main>
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
        <tr v-for="u in ultra" :key="u.mint"><td>{{ shortMint(u.mint) }}</td><td class="num">{{ u.ultra_score }}</td><td class="num">{{ u.hype }}</td><td class="num">{{ u.views_growth_50_probability }}</td></tr></table>
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
const { createApp, ref, onMounted, nextTick, watch } = Vue;
createApp({
  setup() {
    const tabs = [
      { id: 'overview', label: 'Overview' }, { id: 'mint', label: 'Mint' },
      { id: 'hype', label: 'Hype' }, { id: 'ultra', label: 'Ultra' },
      { id: 'shillers', label: 'Shillers' }, { id: 'trending', label: 'Trending' },
      { id: 'leaders', label: 'Leaders' }, { id: 'system', label: 'System' },
    ];
    const active = ref('overview');
    const digest = ref([]); const tasks = ref({ queue: [], dlq: 0 });
    const shillers = ref([]); const cashtags = ref([]);
    const workers = ref([]); const accounts = ref([]);
    const hype = ref([]); const signals = ref([]); const ultra = ref([]);
    const leaders = ref([]); const pagerank = ref([]);
    const mintInput = ref(''); const mintFull = ref(null); const mintError = ref('');
    const mintChart = ref(null);
    let mintChartInstance = null;

    async function api(path) { const r = await fetch(path); if (!r.ok) throw new Error(await r.text()); return r.json(); }
    function fmtNum(n) {
      const v = Number(n); if (!isFinite(v)) return n;
      if (v >= 1e9) return (v/1e9).toFixed(2)+'B';
      if (v >= 1e6) return (v/1e6).toFixed(2)+'M';
      if (v >= 1e3) return (v/1e3).toFixed(1)+'K';
      return String(v);
    }
    function shortMint(m) { return m ? m.slice(0,4)+'…'+m.slice(-4) : ''; }

    async function refresh() {
      try {
        const r = await Promise.all([
          api('/api/digest'), api('/api/tasks'), api('/api/shillers?limit=50'),
          api('/api/cashtags?limit=30'), api('/api/workers'), api('/api/accounts'),
          api('/api/hype/top?limit=30'), api('/api/signals?limit=30'),
          api('/api/ultra/top?limit=30'), api('/api/leaders?limit=50'), api('/api/pagerank?limit=50'),
        ]);
        digest.value = r[0]; tasks.value = r[1]; shillers.value = r[2];
        cashtags.value = r[3]; workers.value = r[4]; accounts.value = r[5];
        hype.value = r[6]; signals.value = r[7]; ultra.value = r[8];
        leaders.value = r[9]; pagerank.value = r[10];
      } catch (e) { console.error(e); }
    }
    async function loadMint() {
      mintError.value = ''; mintFull.value = null;
      if (mintChartInstance) { mintChartInstance.destroy(); mintChartInstance = null; }
      const mint = mintInput.value.trim(); if (!mint) return;
      try {
        mintFull.value = await api('/api/mint/full?mint=' + encodeURIComponent(mint));
        await nextTick();
        if (!mintChart.value) return;
        const f = mintFull.value.dailyFunnel || [];
        const ctx = mintChart.value.getContext('2d');
        if (mintChartInstance) mintChartInstance.destroy();
        mintChartInstance = new Chart(ctx, {
          type: 'line',
          data: { labels: f.map(x => x.day), datasets: [
            { label: 'Твиты', data: f.map(x => x.tweets), borderColor: '#58a6ff', tension: 0.3 },
          ]},
          options: { responsive: true, maintainAspectRatio: false,
            scales: { x: { ticks: { color: '#8b949e' } }, y: { ticks: { color: '#8b949e' } } } }
        });
      } catch (e) { mintError.value = String(e.message || e); }
    }
    onMounted(() => { refresh(); setInterval(refresh, 30000); });
    return { tabs, active, digest, tasks, shillers, cashtags, workers, accounts,
      hype, signals, ultra, leaders, pagerank,
      mintInput, mintFull, mintError, mintChart, loadMint, fmtNum, shortMint };
  },
}).mount('#app');
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const start = Date.now();

  if (AUTH_USER && AUTH_PASS) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="dashboard"');
      res.statusCode = 401; res.end("Unauthorized"); return;
    }
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    if (decoded.slice(0, colon) !== AUTH_USER || decoded.slice(colon + 1) !== AUTH_PASS) {
      res.statusCode = 401; res.end("Unauthorized"); return;
    }
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (MUTATING_ROUTES.has(url.pathname) && req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end(JSON.stringify({ error: "POST required" }));
      return;
    }
    if (!MUTATING_ROUTES.has(url.pathname) && req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(HTML); return;
    }
    const handler = routes[url.pathname];
    if (handler) {
      const data = await handler({ url, method: req.method ?? "GET" });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
      log.debug("api", { path: url.pathname, ms: Date.now() - start });
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("dashboard error", { error: msg });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: msg }));
  }
});

server.on("error", (e) => log.error("dashboard server error", { error: String(e) }));
server.listen(PORT, HOST, () => {
  log.info("dashboard listening", { host: HOST, port: PORT, authenticated: Boolean(AUTH_USER && AUTH_PASS) });
  console.log(`\n🌐 Dashboard: http://${HOST}:${PORT}\n`);
});

process.on("SIGINT", () => { log.info("shutting down dashboard"); server.close(() => process.exit(0)); });

