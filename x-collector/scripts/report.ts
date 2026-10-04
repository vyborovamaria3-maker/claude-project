import { q } from "../lib/trade/pg";
import { listAccounts } from "../lib/trade/account-manager";
import { listWorkers, activeWorkerCount } from "../lib/trade/worker-registry";
import { queueStats, dlqStats } from "../lib/trade/tasks";
import {
  getTopTweetsForMint, getMintFullReport, getTopShillers, getRisingAuthors,
  getTopAuthorsByViews, getCoordinatedAccounts,
  getAuthorGraph, getMintOverlap, getTrendingWords, getCashtagTrends,
  getDailyDigest, getAuthorProfile, toCSV, toJSON,
} from "../lib/trade/analytics";
import { loadGraph, toGEXF, toGraphML, toDOT, toNodesCSV, toEdgesCSV } from "./graph-export";
import * as fs from "node:fs";
import * as path from "node:path";

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
function has(k: string) { return process.argv.includes(`--${k}`); }
function hr(t: string) { console.log("\n" + "━".repeat(72) + "\n  " + t + "\n" + "━".repeat(72)); }

async function main() {
  if (has("accounts")) { hr("Аккаунты"); console.table(await listAccounts()); return; }
  if (has("workers")) {
    hr("Воркеры"); console.table(await listWorkers());
    console.log(`active=${await activeWorkerCount()}`);
    return;
  }
  if (has("tasks")) {
    hr("Задачи"); console.table(await queueStats());
    console.log("DLQ unreviewed:", (await dlqStats())?.n ?? 0);
    return;
  }
  if (has("digest")) { hr("Daily digest"); console.table(await getDailyDigest(arg("day"))); return; }
  if (has("trending-words")) { hr("Тренды слов"); console.table(await getTrendingWords(30)); return; }
  if (has("cashtags")) { hr("Cashtag-тренды"); console.table(await getCashtagTrends(30)); return; }
  if (has("rising")) { hr("Растущие авторы"); console.table(await getRisingAuthors(20)); return; }
  if (has("coordinated")) { hr("Coordinated accounts"); console.table(await getCoordinatedAccounts(30)); return; }
  if (has("graph")) {
    const minW = Number(arg("min-weight") ?? 2);
    hr(`Граф соавторов (weight >= ${minW})`);
    console.table((await getAuthorGraph(minW, 50)).slice(0, 30));
    return;
  }
  if (has("overlap")) { hr("Пересечения монет"); console.table(await getMintOverlap(5, 30)); return; }
  if (has("author")) {
    const h = arg("author");
    if (!h) { console.error("--author нужен"); return; }
    hr(`Профиль @${h}`);
    const p = await getAuthorProfile(h);
    if (!p) { console.log("не найден"); return; }
    console.table([p]);
    return;
  }

  if (has("graph-export")) {
    const format = arg("format") ?? "gexf";
    const outDir = arg("out") ?? "exports";
    const minWeight = Number(arg("min-weight") ?? 2);
    const maxNodes = Number(arg("max-nodes") ?? 2000);
    const onlyVerified = has("verified");

    fs.mkdirSync(outDir, { recursive: true });

    hr(`Загрузка графа (min-weight=${minWeight}, max-nodes=${maxNodes})`);
    const g = await loadGraph({ minWeight, maxNodes, onlyVerified });
    console.log(`Узлов: ${g.meta.nodeCount}, рёбер: ${g.meta.edgeCount}`);

    const ts = new Date().toISOString().slice(0, 10);
    let file: string;
    let content: string;

    switch (format) {
      case "gexf": file = path.join(outDir, `graph-${ts}.gexf`); content = toGEXF(g); break;
      case "graphml": file = path.join(outDir, `graph-${ts}.graphml`); content = toGraphML(g); break;
      case "dot": file = path.join(outDir, `graph-${ts}.dot`); content = toDOT(g); break;
      case "csv":
        file = path.join(outDir, `graph-${ts}-nodes.csv`);
        fs.writeFileSync(file, toNodesCSV(g));
        fs.writeFileSync(path.join(outDir, `graph-${ts}-edges.csv`), toEdgesCSV(g));
        console.log(`✓ ${file}`);
        console.log(`✓ ${path.join(outDir, `graph-${ts}-edges.csv`)}`);
        return;
      default: console.error(`unknown format: ${format}`); return;
    }
    fs.writeFileSync(file, content);
    console.log(`✓ ${file}`);
    return;
  }

  const mintArg = arg("mint");
  if (mintArg && has("full")) {
    hr(`Полный отчёт: ${mintArg}`);
    const r = await getMintFullReport(mintArg, 30);
    if (r.summary) { console.log("\n── Summary ──"); console.table([r.summary]); }
    if (r.dailyFunnel.length) { console.log("\n── Daily funnel ──"); console.table(r.dailyFunnel.slice(-14)); }
    if (r.bursts.length) { console.log("\n── Bursts ──"); console.table(r.bursts); }
    if (r.topAuthors.length) { console.log("\n── Top авторы ──"); console.table(r.topAuthors); }
    if (r.topTweets.length) {
      console.log("\n── Топ твиты ──");
      console.table(r.topTweets.slice(0, 10).map((t) => ({
        handle: t.handle, text: t.text.slice(0, 80),
        views: t.views, likes: t.likes, score: t.engagement_score,
      })));
    }
    if (r.coordinated.length) { console.log("\n── Coordination ──"); console.table(r.coordinated.slice(0, 10)); }
    if (r.overlap.length) { console.log("\n── Overlap ──"); console.table(r.overlap); }
    return;
  }

  if (mintArg) {
    hr(`Монета ${mintArg}`);
    const authors = await q(
      `SELECT handle, tweets_count, total_views, total_likes, is_verified, avg_views
       FROM author_token_stats WHERE mint=$1 ORDER BY total_views DESC LIMIT 30`,
      [mintArg]
    );
    console.table(authors);
    const timeline = await q(
      `SELECT to_char(to_timestamp(t.posted_at/1000), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS tweets, SUM(t.views) AS views
       FROM twitter_tweets t
       JOIN tweet_token_links l ON l.tweet_id = t.tweet_id
       WHERE l.mint = $1 AND t.posted_at IS NOT NULL
       GROUP BY day ORDER BY day`,
      [mintArg]
    );
    hr("Хронология");
    console.table(timeline);
    return;
  }

  if (has("top-shillers")) {
    hr("Топ шиллеров");
    console.table(await getTopShillers(50));
    return;
  }

  if (has("cooccurrence")) {
    hr("Cooccurrence");
    console.table(await getMintOverlap(1, 50));
    return;
  }

  if (has("export") && arg("format") && arg("kind")) {
    const kind = arg("kind")!;
    const fmt = arg("format")!;
    let data: Array<Record<string, unknown>>;
    switch (kind) {
      case "tweets":
        if (!mintArg) { console.error("--mint нужен"); return; }
        data = (await getTopTweetsForMint(mintArg, 1000)) as unknown as Array<Record<string, unknown>>;
        break;
      case "authors": data = (await getTopAuthorsByViews(1000)) as unknown as Array<Record<string, unknown>>; break;
      case "shillers": data = (await getTopShillers(1000)) as unknown as Array<Record<string, unknown>>; break;
      case "trending": data = (await getTrendingWords(500)) as unknown as Array<Record<string, unknown>>; break;
      case "cooccurrence": data = (await getMintOverlap(1, 1000)) as unknown as Array<Record<string, unknown>>; break;
      default: console.error(`unknown kind: ${kind}`); return;
    }
    if (fmt === "csv") console.log(toCSV(data));
    else if (fmt === "json") console.log(toJSON(data));
    else console.error("--format csv|json");
    return;
  }

  console.log(`Использование:
  --accounts --workers --tasks --digest --trending-words --cashtags
  --rising --coordinated --graph --overlap --author @handle
  --mint <ADDR> --full
  --graph-export [--format gexf|graphml|dot|csv] [--out DIR]
  --export --kind tweets|authors|shillers|trending|cooccurrence --format csv|json`);
}

main().catch((e) => { console.error(e); process.exit(1); });

