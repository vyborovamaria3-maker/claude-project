import { NextResponse } from "next/server";
import { hasTwitterAuth, scrapeTwitter, type TweetData } from "../../../../lib/trade/twitter-scraper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { data: XTrendsResponse; ts: number }>();

type TrendCategory = "world" | "crypto" | "solana";

export type XTrendItem = {
  title: string;
  source: string;
  url: string;
  publishedAt: number | null;
  category: TrendCategory;
  score: number;
  tickers: string[];
  keywords: string[];
};

export type MemeCoinToken = {
  rank: number;
  symbol: string;
  name: string;
  mint: string;
  chain: string;
  priceUsd: number;
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  volumeUsd24h: number;
  liquidityUsd: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  txns24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  dexUrl: string;
  narrative: string[];
  hypeScore: number;
};

export type MemeCoinNarrative = {
  name: string;
  tokens: string[];
  newsCount: number;
  momentumScore: number;
  description: string;
};

export type FearGreedData = {
  value: number;
  label: string;
  updatedAt: number;
};

export type MemeCoinAnalytics = {
  topGainers: MemeCoinToken[];
  topVolume: MemeCoinToken[];
  solanaMemes: MemeCoinToken[];
  narratives: MemeCoinNarrative[];
  fearGreed: FearGreedData | null;
  totalMemeVolume24h: number;
  dominantNarrative: string | null;
  momentumShift: "bullish" | "bearish" | "neutral";
};

export type XTrendsResponse = {
  updatedAt: number;
  categories: Record<TrendCategory, XTrendItem[]>;
  hotKeywords: Array<{ keyword: string; count: number; categories: TrendCategory[] }>;
  hotTickers: Array<{ ticker: string; count: number; categories: TrendCategory[] }>;
  memecoins: MemeCoinAnalytics;
};

const TWITTER_TREND_QUERIES: Array<{ category: TrendCategory; query: string; weight: number; limit: number }> = [
   { category: "world",  query: 'memecoin OR meme coin OR pumpfun OR pump.fun OR degen OR moonshot OR 100x', weight: 1.35, limit: 12 },
   { category: "crypto", query: 'BONK OR WIF OR PEPE OR POPCAT OR FARTCOIN OR DOGE OR SHIB OR PENGU', weight: 1.4, limit: 12 },
   { category: "solana", query: 'solana memecoin OR pumpfun OR raydium OR jupiter OR migrated OR graduation', weight: 1.45, limit: 12 },
 ];

const TWITTER_MEME_FALLBACK_QUERIES: Array<{ category: TrendCategory; query: string; weight: number; limit: number }> = [
  { category: "world",  query: 'memecoin OR degen OR moonshot', weight: 1.25, limit: 10 },
  { category: "crypto", query: 'pumpfun OR bonk OR wif OR pepe', weight: 1.3, limit: 10 },
  { category: "solana", query: 'solana meme OR solana memecoin OR pumpfun', weight: 1.35, limit: 10 },
];

const KEYWORD_PATTERNS = [
  "memecoin", "meme coin", "meme", "pump.fun", "pumpfun", "degen", "alpha", "call", "calls",
  "solana", "raydium", "jupiter", "bonk", "wif", "pepe", "popcat", "fartcoin", "doge", "shib", "pengu",
  "launch", "migrated", "graduation", "bonding curve", "fair launch", "stealth launch", "community takeover",
  "1000x", "100x", "moonshot", "ape", "sniper", "snipe", "holder", "holders", "cto", "buyback", "burn",
  "rug", "rugpull", "honeypot", "scam", "airdrop",
];

const MEME_NARRATIVE_PATTERNS: Array<{ name: string; patterns: RegExp; description: string }> = [
  { name: "AI Agents",         patterns: /\b(ai agent|ai coin|artificial intelligence|chatgpt|grok|claude|llm token)\b/i, description: "РўРѕРєРµРЅС‹ СЃРІСЏР·Р°РЅРЅС‹Рµ СЃ AI Рё СЏР·С‹РєРѕРІС‹РјРё РјРѕРґРµР»СЏРјРё" },
  { name: "Dog Coins",         patterns: /\b(doge|shib|floki|bonk|wif|myro|wen|dogwifhat|dog coin|dog token)\b/i,        description: "РЎРѕР±Р°С‡СЊСЏ РЅР°СЂСЂР°С‚РёРІ вЂ” РєР»Р°СЃСЃРёРєР° РјРµРјРєРѕРёРЅРѕРІ" },
  { name: "Frog / Pepe",       patterns: /\b(pepe|frog|wojak|chad|mog|brett|pepe token)\b/i,                             description: "Р›СЏРіСѓС€Р°С‡РёР№ РЅР°СЂСЂР°С‚РёРІ РЅР° Р±Р°Р·Рµ РјРµРјРѕРІ" },
  { name: "Political",         patterns: /\b(trump|maga|biden|political|president|election coin)\b/i,                    description: "РџРѕР»РёС‚РёС‡РµСЃРєРёРµ РјРµРјРєРѕРёРЅС‹" },
  { name: "Animal Meta",       patterns: /\b(cat|kitten|hamster|penguin|pengu|popcat|goat|rat|frog coin)\b/i,            description: "Р–РёРІРѕС‚РЅР°СЏ С‚РµРјР° вЂ” С€РёСЂРѕРєР°СЏ РјРµРј-РЅР°СЂСЂР°С‚РёРІР°" },
  { name: "Pump.fun Native",   patterns: /\b(pump\.?fun|pumpfun|bonding curve|graduation|migrated)\b/i,                  description: "РњРѕРЅРµС‚С‹ Р·Р°РїСѓС‰РµРЅРЅС‹Рµ С‡РµСЂРµР· Pump.fun" },
  { name: "Base Memes",        patterns: /\b(base chain|base meme|basechain|coinbase chain|brett|toshi)\b/i,             description: "РњРµРјРєРѕРёРЅС‹ РЅР° СЃРµС‚Рё Base" },
  { name: "Solana Ecosystem",  patterns: /\b(solana|sol|raydium|jupiter|jup|orca|meteora)\b/i,                           description: "РЎРѕР»Р°РЅР°-РЅР°СЂСЂР°С‚РёРІ Рё СЌРєРѕСЃРёСЃС‚РµРјРЅС‹Рµ РјРѕРЅРµС‚С‹" },
  { name: "Celebrity / Brand", patterns: /\b(elon|musk|celebrity|brand token|influencer coin)\b/i,                      description: "РњРѕРЅРµС‚С‹ СЃРІСЏР·Р°РЅРЅС‹Рµ СЃ РїРµСЂСЃРѕРЅР°РјРё РёР»Рё Р±СЂРµРЅРґР°РјРё" },
  { name: "RWA / Utility Meme",patterns: /\b(real world asset|rwa|utility|staking meme|yield meme)\b/i,                  description: "РњРµРјС‹ СЃ СѓС‚РёР»РёС‚Р°СЂРЅРѕР№ СЃРѕСЃС‚Р°РІР»СЏСЋС‰РµР№" },
];

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function extractKeywords(title: string): string[] {
  const lower = title.toLowerCase();
  return KEYWORD_PATTERNS.filter((keyword) => lower.includes(keyword));
}

function extractTickers(title: string): string[] {
  const matches = title.match(/\$[A-Z][A-Z0-9]{1,9}\b/g) || [];
  const symbols = title.match(/\b(BTC|ETH|SOL|BONK|WIF|POPCAT|FARTCOIN|PENGU|TRUMP|PEPE|DOGE|SHIB)\b/g) || [];
  return Array.from(new Set([...matches.map((v) => v.replace(/^\$/, "")), ...symbols]));
}

function scoreItem(title: string, publishedAt: number | null, category: TrendCategory, weight: number): number {
  const ageHours = publishedAt ? Math.max((Date.now() - publishedAt) / 3600000, 0) : 12;
  const freshness = Math.max(0, 24 - ageHours) / 24;
  const keywordBoost = extractKeywords(title).length * 0.25;
  const tickerBoost = extractTickers(title).length * 0.35;
  const categoryBoost = category === "solana" ? 0.25 : category === "crypto" ? 0.15 : 0;
  return Math.round((freshness + keywordBoost + tickerBoost + categoryBoost) * weight * 100);
}

 function normalizeTweetTitle(text: string): string {
   const normalized = text
     .replace(/https?:\/\/\S+/g, "")
     .replace(/\s+/g, " ")
     .trim();
   if (normalized.length <= 220) return normalized;
   return `${normalized.slice(0, 217).trim()}...`;
 }

 function scoreTweetItem(tweet: TweetData, category: TrendCategory, weight: number): number {
   const ageHours = tweet.postedAt ? Math.max((Date.now() - tweet.postedAt) / 3600000, 0) : 12;
   const freshness = Math.max(0, 24 - ageHours) / 24;
   const rawEngagement = tweet.likes + tweet.retweets * 2 + tweet.replies + Math.round(tweet.views / 500);
   const engagementBoost = Math.log10(Math.max(rawEngagement, 1) + 1);
   const keywordBoost = extractKeywords(tweet.text).length * 0.2;
   const tickerBoost = extractTickers(tweet.text).length * 0.3;
   const verifiedBoost = tweet.isVerified ? 0.25 : 0;
   const categoryBoost = category === "solana" ? 0.25 : category === "crypto" ? 0.15 : 0;
   return Math.round((freshness + engagementBoost + keywordBoost + tickerBoost + verifiedBoost + categoryBoost) * weight * 100);
 }

 async function fetchTwitterTrendItems(category: TrendCategory, query: string, weight: number, limit: number): Promise<XTrendItem[]> {
   try {
     const result = await scrapeTwitter(query, {
       limit,
       strategy: "auto",
       headless: true,
     });
     return result.tweets.map((tweet) => {
       const title = normalizeTweetTitle(tweet.text);
       return {
         title,
         source: tweet.authorDisplayName ? `${tweet.authorDisplayName} · X` : `@${tweet.authorHandle} · X`,
         url: tweet.url || `https://x.com/${tweet.authorHandle}/status/${tweet.id}`,
         publishedAt: tweet.postedAt,
         category,
         score: scoreTweetItem(tweet, category, weight),
         tickers: extractTickers(title),
         keywords: extractKeywords(title),
       };
     }).filter((item) => item.title);
   } catch {
     return [];
   }
 }

async function fetchFearGreed(): Promise<FearGreedData | null> {
  try {
    const response = await fetch("https://api.alternative.me/fng/?limit=1&format=json", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    type FngData = { data: Array<{ value: string; value_classification: string; timestamp: string }> };
    const json = (await response.json()) as FngData;
    const item = json.data?.[0];
    if (!item) return null;
    return {
      value: parseInt(item.value, 10),
      label: item.value_classification,
      updatedAt: parseInt(item.timestamp, 10) * 1000,
    };
  } catch {
    return null;
  }
}

type DexPairRaw = {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { symbol: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  txns?: { h24?: { buys?: number; sells?: number } };
  url?: string;
  pairAddress?: string;
};

const MEME_SEARCH_QUERIES = [
  "meme",
  "pepe",
  "doge",
  "bonk",
  "wif",
  "trump",
  "ai",
  "cat",
  "frog",
];

function detectTokenNarratives(name: string, symbol: string): string[] {
  const text = `${name} ${symbol}`.toLowerCase();
  return MEME_NARRATIVE_PATTERNS
    .filter((n) => n.patterns.test(text))
    .map((n) => n.name);
}

function calcHypeScore(token: DexPairRaw): number {
  const vol = token.volume?.h24 ?? 0;
  const liq = token.liquidity?.usd ?? 1;
  const change24 = Math.abs(token.priceChange?.h24 ?? 0);
  const change1h = Math.abs(token.priceChange?.h1 ?? 0);
  const txns = (token.txns?.h24?.buys ?? 0) + (token.txns?.h24?.sells ?? 0);
  const volLiqRatio = liq > 0 ? Math.min(vol / liq, 50) : 0;
  const momentumBonus = change1h > 20 ? 15 : change1h > 10 ? 8 : change1h > 5 ? 4 : 0;
  const txBonus = Math.min(txns / 100, 15);
  return Math.round(Math.min(100, volLiqRatio * 1.2 + change24 * 0.3 + momentumBonus + txBonus));
}

function mapPairToMemeCoin(pair: DexPairRaw, rank: number): MemeCoinToken {
  const narratives = detectTokenNarratives(pair.baseToken.name, pair.baseToken.symbol);
  return {
    rank,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    mint: pair.baseToken.address,
    chain: pair.chainId,
    priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : 0,
    change1h: pair.priceChange?.h1 ?? null,
    change6h: pair.priceChange?.h6 ?? null,
    change24h: pair.priceChange?.h24 ?? null,
    volumeUsd24h: pair.volume?.h24 ?? 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    marketCapUsd: pair.marketCap ?? null,
    fdvUsd: pair.fdv ?? null,
    txns24h: (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0) || null,
    buys24h: pair.txns?.h24?.buys ?? null,
    sells24h: pair.txns?.h24?.sells ?? null,
    dexUrl: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.baseToken.address}`,
    narrative: narratives,
    hypeScore: calcHypeScore(pair),
  };
}

async function fetchDexScreenerMemes(): Promise<{ gainers: MemeCoinToken[]; volume: MemeCoinToken[]; solanaMemes: MemeCoinToken[] }> {
  const empty = { gainers: [], volume: [], solanaMemes: [] };
  try {
    const results = await Promise.allSettled([
      fetch("https://api.dexscreener.com/token-boosts/top/v1", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(7000), cache: "no-store" }),
      fetch("https://api.dexscreener.com/token-profiles/latest/v1", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(7000), cache: "no-store" }),
    ]);

    type BoostItem = { chainId: string; tokenAddress: string; description?: string; url?: string };
    const boostMints: string[] = [];
    if (results[0].status === "fulfilled" && results[0].value.ok) {
      const boosts = (await results[0].value.json()) as BoostItem[];
      boosts.filter((b) => ["solana", "ethereum", "base"].includes(b.chainId)).slice(0, 20).forEach((b) => boostMints.push(`${b.chainId}:${b.tokenAddress}`));
    }
    if (results[1].status === "fulfilled" && results[1].value.ok) {
      const profiles = (await results[1].value.json()) as BoostItem[];
      profiles.filter((b) => ["solana", "ethereum", "base"].includes(b.chainId)).slice(0, 20).forEach((b) => {
        const key = `${b.chainId}:${b.tokenAddress}`;
        if (!boostMints.includes(key)) boostMints.push(key);
      });
    }

    if (boostMints.length === 0) return empty;

    const solMints = boostMints.filter((m) => m.startsWith("solana:")).slice(0, 10).map((m) => m.replace("solana:", ""));
    const otherMints = boostMints.filter((m) => !m.startsWith("solana:")).slice(0, 10).map((m) => m.split(":")[1]);
    const allMintsForQuery = [...new Set([...solMints, ...otherMints])].slice(0, 15).join(",");

    if (!allMintsForQuery) return empty;

    const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${allMintsForQuery}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!pairsRes.ok) return empty;

    type PairsResponse = { pairs?: DexPairRaw[] };
    const { pairs = [] } = (await pairsRes.json()) as PairsResponse;

    const byMint = new Map<string, DexPairRaw>();
    for (const pair of pairs) {
      if (!["solana", "ethereum", "base"].includes(pair.chainId)) continue;
      const existing = byMint.get(pair.baseToken.address);
      if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        byMint.set(pair.baseToken.address, pair);
      }
    }

    const allPairs = Array.from(byMint.values());
    const solPairs = allPairs.filter((p) => p.chainId === "solana");

    const byVolume = [...allPairs].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0)).slice(0, 10);
    const byGain = [...allPairs].filter((p) => (p.priceChange?.h24 ?? 0) > 0).sort((a, b) => (b.priceChange?.h24 ?? 0) - (a.priceChange?.h24 ?? 0)).slice(0, 10);
    const bySolHype = [...solPairs].sort((a, b) => calcHypeScore(b) - calcHypeScore(a)).slice(0, 12);

    return {
      gainers:     byGain.map((p, i) => mapPairToMemeCoin(p, i + 1)),
      volume:      byVolume.map((p, i) => mapPairToMemeCoin(p, i + 1)),
      solanaMemes: bySolHype.map((p, i) => mapPairToMemeCoin(p, i + 1)),
    };
  } catch {
    return empty;
  }
}

function buildNarratives(tokens: MemeCoinToken[], newsItems: XTrendItem[]): MemeCoinNarrative[] {
  const narrativeMap = new Map<string, { tokens: Set<string>; newsCount: number; momentumSum: number }>();

  for (const token of tokens) {
    for (const n of token.narrative) {
      const entry = narrativeMap.get(n) || { tokens: new Set(), newsCount: 0, momentumSum: 0 };
      entry.tokens.add(token.symbol);
      entry.momentumSum += token.hypeScore;
      narrativeMap.set(n, entry);
    }
  }

  for (const item of newsItems) {
    const text = item.title.toLowerCase();
    for (const np of MEME_NARRATIVE_PATTERNS) {
      if (np.patterns.test(text)) {
        const entry = narrativeMap.get(np.name) || { tokens: new Set(), newsCount: 0, momentumSum: 0 };
        entry.newsCount += 1;
        narrativeMap.set(np.name, entry);
      }
    }
  }

  return Array.from(narrativeMap.entries())
    .map(([name, data]) => {
      const np = MEME_NARRATIVE_PATTERNS.find((n) => n.name === name);
      const tokenCount = data.tokens.size;
      const momentumScore = Math.round((data.momentumSum / Math.max(tokenCount, 1)) * 0.6 + data.newsCount * 8);
      return {
        name,
        tokens: Array.from(data.tokens).slice(0, 6),
        newsCount: data.newsCount,
        momentumScore: Math.min(100, momentumScore),
        description: np?.description || "",
      };
    })
    .filter((n) => n.tokens.length > 0 || n.newsCount > 0)
    .sort((a, b) => b.momentumScore - a.momentumScore)
    .slice(0, 8);
}

function buildFallbackTrendItems(tokens: MemeCoinToken[], category: TrendCategory): XTrendItem[] {
  return tokens
    .slice(0, category === "world" ? 8 : 10)
    .map((token) => ({
      title: `$${token.symbol} · ${token.name} · hype ${token.hypeScore}`,
      source: token.chain === "solana" ? "Solana meme flow" : "Memecoin flow",
      url: token.dexUrl,
      publishedAt: Date.now(),
      category,
      score: 100 + token.hypeScore,
      tickers: [token.symbol],
      keywords: Array.from(new Set([
        "memecoin",
        token.chain,
        ...(token.narrative.length > 0 ? token.narrative.map((item) => item.toLowerCase()) : ["alpha"]),
        ...(token.change24h !== null && token.change24h > 20 ? ["moonshot"] : []),
      ])),
    }));
}

function buildFallbackHotKeywords(narratives: MemeCoinNarrative[]): Array<{ keyword: string; count: number; categories: TrendCategory[] }> {
  return narratives.slice(0, 8).map((item) => ({
    keyword: item.name,
    count: Math.max(item.newsCount, item.tokens.length, 1),
    categories: ["crypto", "solana"],
  }));
}

function buildFallbackHotTickers(tokens: MemeCoinToken[]): Array<{ ticker: string; count: number; categories: TrendCategory[] }> {
  const unique = new Map<string, MemeCoinToken>();
  for (const token of tokens) {
    if (!unique.has(token.symbol)) unique.set(token.symbol, token);
  }
  return Array.from(unique.values())
    .sort((a, b) => b.hypeScore - a.hypeScore)
    .slice(0, 10)
    .map((token) => ({
      ticker: token.symbol,
      count: Math.max(1, Math.round(token.hypeScore / 10)),
      categories: token.chain === "solana" ? ["crypto", "solana"] : ["crypto"],
    }));
}

function aggregate(items: XTrendItem[], field: "keywords" | "tickers") {
  const map = new Map<string, { count: number; categories: Set<TrendCategory> }>();
  for (const item of items) {
    for (const value of item[field]) {
      const key = field === "tickers" ? value.toUpperCase() : value.toLowerCase();
      const entry = map.get(key) || { count: 0, categories: new Set<TrendCategory>() };
      entry.count += 1;
      entry.categories.add(item.category);
      map.set(key, entry);
    }
  }
  return Array.from(map.entries())
    .map(([keyword, value]) => ({ keyword, ticker: keyword, count: value.count, categories: Array.from(value.categories) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

const TRANSLATION_MAP: Record<string, string> = {
  "breaking": "РЎСЂРѕС‡РЅРѕРµ",
  "war": "Р’РѕР№РЅР°",
  "election": "Р’С‹Р±РѕСЂС‹",
  "fed": "Р¤Р РЎ",
  "inflation": "РРЅС„Р»СЏС†РёСЏ",
  "tariffs": "РўР°СЂРёС„С‹",
  "ai": "РР",
  "nvidia": "NVIDIA",
  "oil": "РќРµС„С‚СЊ",
  "gold": "Р—РѕР»РѕС‚Рѕ",
  "bitcoin": "Р‘РёС‚РєРѕРёРЅ",
  "ethereum": "Р­С„РёСЂРёСѓРј",
  "solana": "РЎРѕР»Р°РЅР°",
  "memecoin": "РњРµРјРєРѕРёРЅ",
  "meme coin": "РњРµРјРєРѕРёРЅ",
  "pump.fun": "Pump.fun",
  "raydium": "Raydium",
  "jupiter": "Jupiter",
  "airdrop": "Р­РёСЂРґСЂРѕРї",
  "hack": "Р’Р·Р»РѕРј",
  "exploit": "Р­РєСЃРїР»РѕР№С‚",
  "etf": "ETF",
  "sec": "SEC",
  "binance": "Binance",
  "coinbase": "Coinbase",
  "whale": "РљРёС‚",
  "degen": "Р”РµРіРµРЅ",
  "launch": "Р—Р°РїСѓСЃРє",
  "trending": "РўСЂРµРЅРґ",
  "rug": "Р Р°РіРїСѓР»Р»",
  "rugpull": "Р Р°РіРїСѓР»Р»",
  "honeypot": "РҐР°РЅРёРїРѕС‚",
  "scam": "РЎРєР°Рј",
  "burn": "РЎРѕР¶Р¶РµРЅРёРµ",
  "buyback": "Р‘Р°Р№Р±СЌРє",
  "cto": "CTO",
  "community takeover": "РЎРјРµРЅР° РєРѕРјР°РЅРґС‹",
  "1000x": "1000x",
  "100x": "100x",
  "moonshot": "РњСѓРЅС€РѕС‚",
  "presale": "РџСЂРµСЃРµР№Р»",
  "fair launch": "Р§РµСЃС‚РЅС‹Р№ Р·Р°РїСѓСЃРє",
  "stealth launch": "РЎРєСЂС‹С‚С‹Р№ Р·Р°РїСѓСЃРє",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function translateTitle(title: string, lang: string): string {
  if (lang !== "ru") return title;
  let translated = title;
  const entries = Object.entries(TRANSLATION_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [en, ru] of entries) {
    const regex = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(en)})(?=[^A-Za-z0-9]|$)`, "gi");
    translated = translated.replace(regex, (_match, prefix: string) => `${prefix}${ru}`);
  }
  return translated;
}

function translateKeywords(keywords: string[], lang: string): string[] {
  if (lang !== "ru") return keywords;
  return keywords.map((k) => TRANSLATION_MAP[k.toLowerCase()] || k);
}

async function translateTextBatch(texts: string[], lang: string): Promise<string[]> {
  if (lang !== "ru" || texts.length === 0) return texts;
  const fallback = texts.map((text) => translateTitle(text, lang));
  const delimiter = "__X_TRENDS_SPLIT__";

  try {
    const response = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=${encodeURIComponent(texts.join(`\n${delimiter}\n`))}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      },
    );
    if (!response.ok) return fallback;

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) return fallback;

    const translated = (payload[0] as Array<unknown[]>)
      .map((chunk) => typeof chunk?.[0] === "string" ? chunk[0] : "")
      .join("");
    const parts = translated.split(delimiter).map((part) => part.trim());

    return parts.length === texts.length ? parts : fallback;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lang = url.searchParams.get("lang") || "en";
  const cacheKey = `x-trends-memecoin-v2-${lang}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "public, max-age=120" } });
  }

  const [twitterResults, memeData, fearGreed] = await Promise.all([
    Promise.allSettled(TWITTER_TREND_QUERIES.map((item) => fetchTwitterTrendItems(item.category, item.query, item.weight, item.limit))),
    fetchDexScreenerMemes(),
    fetchFearGreed(),
  ]);

  const twitterItems = twitterResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  let rawItems = twitterItems;
  if (rawItems.length === 0) {
    const fallbackResults = await Promise.allSettled(TWITTER_MEME_FALLBACK_QUERIES.map((item) => fetchTwitterTrendItems(item.category, item.query, item.weight, item.limit)));
    rawItems = fallbackResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  const translatedTitles = await translateTextBatch(rawItems.map((item) => item.title), lang);
  const allItems = rawItems.map((item, index) => ({
    ...item,
    title: translatedTitles[index] || translateTitle(item.title, lang),
    keywords: translateKeywords(item.keywords, lang),
  }));

  const worldItems = allItems.filter((item) => item.category === "world").sort((a, b) => b.score - a.score).slice(0, 8);
  const cryptoItems = allItems.filter((item) => item.category === "crypto");
  const rankedCryptoItems = cryptoItems.sort((a, b) => b.score - a.score).slice(0, 10);
  const solanaItems = allItems.filter((item) => item.category === "solana").sort((a, b) => b.score - a.score).slice(0, 10);

  const allMemeTokens = [...memeData.gainers, ...memeData.volume, ...memeData.solanaMemes];
  const narratives = buildNarratives(allMemeTokens, cryptoItems);

  const fallbackWorldItems = buildFallbackTrendItems([...memeData.volume, ...memeData.gainers], "world");
  const fallbackCryptoItems = buildFallbackTrendItems([...memeData.gainers, ...memeData.volume], "crypto");
  const fallbackSolanaItems = buildFallbackTrendItems(memeData.solanaMemes, "solana");

  const categories: XTrendsResponse["categories"] = {
    world:  worldItems.length > 0 ? worldItems : fallbackWorldItems,
    crypto: rankedCryptoItems.length > 0 ? rankedCryptoItems : fallbackCryptoItems,
    solana: solanaItems.length > 0 ? solanaItems : fallbackSolanaItems,
  };

  const totalMemeVolume24h = memeData.volume.reduce((sum, t) => sum + t.volumeUsd24h, 0);
  const dominantNarrative = narratives[0]?.name ?? null;

  const avgChange24h = allMemeTokens.length > 0
    ? allMemeTokens.reduce((sum, t) => sum + (t.change24h ?? 0), 0) / allMemeTokens.length
    : 0;
  const momentumShift: MemeCoinAnalytics["momentumShift"] =
    avgChange24h > 5 ? "bullish" : avgChange24h < -5 ? "bearish" : "neutral";

  const memecoins: MemeCoinAnalytics = {
    topGainers:      memeData.gainers,
    topVolume:       memeData.volume,
    solanaMemes:     memeData.solanaMemes,
    narratives,
    fearGreed,
    totalMemeVolume24h,
    dominantNarrative,
    momentumShift,
  };

  const data: XTrendsResponse = {
    updatedAt: Date.now(),
    categories,
    hotKeywords: (() => {
      const aggregated = aggregate(allItems, "keywords").map(({ keyword, count, categories }) => ({ keyword: translateKeywords([keyword], lang)[0], count, categories }));
      return aggregated.length > 0 ? aggregated : buildFallbackHotKeywords(narratives);
    })(),
    hotTickers: (() => {
      const aggregated = aggregate(allItems, "tickers").map(({ ticker, count, categories }) => ({ ticker, count, categories }));
      return aggregated.length > 0 ? aggregated : buildFallbackHotTickers(allMemeTokens);
    })(),
    memecoins,
  };

  cache.set(cacheKey, { data, ts: Date.now() });
  return NextResponse.json(data, { headers: { "Cache-Control": "public, max-age=120" } });
}

