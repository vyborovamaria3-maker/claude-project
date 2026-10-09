import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  fetchTokenMeta,
  normalizeTwitterHandle,
  scrapeTwitterUserTimeline,
} from "@/lib/trade/twitter-scraper";
import { computeAQS } from "@/lib/trade/audience-quality-score";
import {
  computePostPriceImpact,
  summarizePriceImpacts,
  summarizeReactions,
  type PriceCandle,
} from "@/lib/trade/twitter-author-impact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map<string, { ts: number; data: unknown }>();

function validMint(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "string" && value.trim() && !/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const number = finiteNumber(value);
  if (number == null || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

function rowsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    for (const key of ["candles", "data", "items", "ohlcv", "result"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
  }

  return [];
}

function normalizeCandle(row: unknown): PriceCandle | null {
  if (Array.isArray(row)) {
    if (row.length < 5) return null;

    const timestamp = normalizeTimestamp(row[0]);
    const open = finiteNumber(row[1]);
    const high = finiteNumber(row[2]);
    const low = finiteNumber(row[3]);
    const close = finiteNumber(row[4]);

    if (
      timestamp == null ||
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      close <= 0
    ) {
      return null;
    }

    return { timestamp, open, high, low, close };
  }

  if (!row || typeof row !== "object") return null;
  const object = row as Record<string, unknown>;

  const timestamp = normalizeTimestamp(
    object.timestamp ??
      object.time ??
      object.t ??
      object.openTime ??
      object.startTime ??
      object.createdAt,
  );

  const open = finiteNumber(object.open ?? object.o ?? object.priceOpen);
  const high = finiteNumber(object.high ?? object.h ?? object.priceHigh);
  const low = finiteNumber(object.low ?? object.l ?? object.priceLow);
  const close = finiteNumber(
    object.close ??
      object.c ??
      object.price ??
      object.priceClose ??
      object.usdPrice,
  );

  if (timestamp == null || close == null || close <= 0) return null;

  return {
    timestamp,
    open: open ?? close,
    high: high ?? close,
    low: low ?? close,
    close,
  };
}

async function fetchPumpCandles(
  mint: string,
  interval: "1m" | "15m",
): Promise<PriceCandle[]> {
  try {
    const response = await fetch(
      `https://swap-api.pump.fun/v1/coins/${encodeURIComponent(mint)}/candles?interval=${interval}&limit=1000`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) return [];

    const payload: unknown = await response.json().catch(() => []);
    return rowsFromPayload(payload)
      .map(normalizeCandle)
      .filter((candle): candle is PriceCandle => candle != null);
  } catch {
    return [];
  }
}

type TokenMentionReason =
  | "contract_exact"
  | "cashtag_exact"
  | "hashtag_exact"
  | "bare_ticker_context"
  | null;

function tokenMentionReason(
  text: string,
  symbol: string,
  addresses: string[],
): TokenMentionReason {
  const lower = text.toLowerCase();

  if (
    addresses.some(
      (address) =>
        Boolean(address) &&
        lower.includes(address.toLowerCase()),
    )
  ) {
    return "contract_exact";
  }

  const clean = symbol.trim().replace(/^\$/, "");
  if (!clean) return null;

  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (
    new RegExp(`\\$${escaped}(?![A-Za-z0-9_])`, "i").test(text)
  ) {
    return "cashtag_exact";
  }

  if (
    new RegExp(`#${escaped}(?![A-Za-z0-9_])`, "i").test(text)
  ) {
    return "hashtag_exact";
  }

  if (clean.length >= 3) {
    const bare = new RegExp(
      `(?:^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`,
      "i",
    );

    const context =
      /\b(token|coin|meme|memecoin|solana|pump|ape|aped|buy|bought|sell|sold|chart|market\s*cap|mcap|liquidity|launch|ca|contract|dex|swap|holder|holders)\b/i;

    if (bare.test(text) && context.test(text)) {
      return "bare_ticker_context";
    }
  }

  return null;
}

export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint")?.trim() || "";
  const author = normalizeTwitterHandle(
    request.nextUrl.searchParams.get("author"),
  );
  const requestedLimit = Number.parseInt(
    request.nextUrl.searchParams.get("limit") || "20",
    10,
  );
  const limit = Math.max(
    8,
    Math.min(20, Number.isFinite(requestedLimit) ? requestedLimit : 20),
  );

  if (!validMint(mint)) {
    return NextResponse.json({ error: "invalid Solana mint" }, { status: 400 });
  }

  if (!author || !/^[A-Za-z0-9_]{1,30}$/.test(author)) {
    return NextResponse.json({ error: "invalid X handle" }, { status: 400 });
  }

  const cacheKey = `${mint}:${author}:${limit}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json({
      ...(cached.data as Record<string, unknown>),
      cached: true,
    });
  }

  const meta = await fetchTokenMeta(mint);
  const resolvedMint = meta?.tokenMint || mint;
  const symbol = meta?.symbol || "";
  const addresses = Array.from(
    new Set(
      [
        resolvedMint,
        mint,
        ...(meta?.poolAddresses || []),
      ].filter(Boolean),
    ),
  );

  let timeline;
  try {
    timeline = await scrapeTwitterUserTimeline(author, {
      limit,
    });
  } catch {
    return NextResponse.json(
      {
        error: "failed to load X author timeline",
        author,
      },
      { status: 502 },
    );
  }

  const expectedAuthor = author.toLowerCase();

  const posts = timeline.tweets
    .filter(
      (tweet) =>
        String(normalizeTwitterHandle(tweet.authorHandle) || "")
          .toLowerCase() === expectedAuthor,
    )
    .slice(0, limit);

  if (posts.length === 0) {
    return NextResponse.json(
      {
        error: "X author timeline returned no visible posts",
        author,
        historyMode: timeline.historyMode,
      },
      { status: 404 },
    );
  }

  const profilePost =
    posts.find(
      (tweet) =>
        tweet.authorFollowers != null ||
        tweet.authorPostsCount != null,
    ) || posts[0];

  const followers = Number(profilePost.authorFollowers || 0);
  const following = Number(profilePost.authorFollowing || 0);
  const postsCount = Number(profilePost.authorPostsCount || 0);
  const listedCount = Number(profilePost.authorListedCount || 0);
  const favouritesCount = Number(
    profilePost.authorFavouritesCount || 0,
  );
  const mediaCount = Number(profilePost.authorMediaCount || 0);

  const reactionInput = posts.map((tweet) => ({
    id: tweet.id,
    timestamp: tweet.postedAt,
    views: tweet.views,
    viewsKnown: tweet.viewsKnown,
    likes: tweet.likes,
    retweets: tweet.retweets,
    replies: tweet.replies,
    quotes: tweet.quotes,
    bookmarks: tweet.bookmarks,
  }));

  const reactions = summarizeReactions(reactionInput, followers);

  const createdAt =
    profilePost.authorCreatedAt != null
      ? new Date(profilePost.authorCreatedAt).toISOString()
      : null;

  const aqs = computeAQS({
    followers,
    following,
    postsCount,
    createdAt,
    verified: Boolean(profilePost.isVerified),
    blueVerified: Boolean(profilePost.authorIsBlueVerified),
    listedCount,
    favouritesCount,
    mediaCount,
    recentPosts: posts.map((tweet) => ({
      views: tweet.viewsKnown ? tweet.views : 0,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      quotes: tweet.quotes,
      bookmarks: tweet.bookmarks,
    })),
  });

  const classifiedPosts = posts.map((tweet) => ({
    tweet,
    matchReason: tokenMentionReason(
      tweet.text,
      symbol,
      addresses,
    ),
  }));

  const tokenPosts = classifiedPosts
    .filter(
      (entry) => entry.matchReason != null,
    );

  let candles: PriceCandle[] = [];
  let marketSource = "unavailable";

  if (tokenPosts.length > 0) {
    const [minute, fifteen] = await Promise.all([
      fetchPumpCandles(resolvedMint, "1m"),
      fetchPumpCandles(resolvedMint, "15m"),
    ]);

    const merged = new Map<number, PriceCandle>();

    for (const candle of fifteen) {
      merged.set(candle.timestamp, candle);
    }
    for (const candle of minute) {
      merged.set(candle.timestamp, candle);
    }

    candles = Array.from(merged.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    if (candles.length > 0) {
      marketSource = "pumpfun-candles";
    }
  }

  const tokenPostResults = tokenPosts.map(
    ({ tweet, matchReason }) => ({
      id: tweet.id,
      text: tweet.text,
      url: tweet.url,
      timestamp: tweet.postedAt,
      views: tweet.views,
      viewsKnown: tweet.viewsKnown,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      quotes: tweet.quotes,
      bookmarks: tweet.bookmarks,
      matchReason,
      priceImpact: computePostPriceImpact(
        tweet.postedAt,
        candles,
      ),
    }),
  );

  const impact = summarizePriceImpacts(
    tokenPostResults.map((post) => post.priceImpact),
  );

  const pricedMentions = tokenPostResults.filter(
    (post) =>
      Object.entries(post.priceImpact).some(
        ([key, value]) =>
          key !== "basePrice" &&
          value != null &&
          Number.isFinite(value),
      ),
  ).length;

  const impactConfidence =
    pricedMentions >= 5
      ? "High"
      : pricedMentions >= 3
        ? "Medium"
        : "Low";

  const data = {
    author,
    mint,
    resolvedMint,
    symbol,
    provider: "twscrape-x-graphql",
    historyMode: timeline.historyMode,
    marketSource,
    cached: false,
    sampledPosts: posts.length,
    tokenMentionPosts: tokenPosts.length,
    pricedTokenMentions: pricedMentions,
    impactConfidence,
    causality: "correlation-only",
    profile: {
      followers,
      following,
      postsCount,
      listedCount,
      favouritesCount,
      mediaCount,
      createdAt,
      location: profilePost.authorLocation || null,
      verified: Boolean(profilePost.isVerified),
      blueVerified: Boolean(profilePost.authorIsBlueVerified),
      verificationType:
        profilePost.authorVerificationType || null,
    },
    audience: {
      aqs,
      reactions,
    },
    impact,
    recentPosts: classifiedPosts.slice(0, 12).map(
      ({ tweet, matchReason }) => ({
        id: tweet.id,
        text: tweet.text,
        url: tweet.url,
        timestamp: tweet.postedAt,
        views: tweet.views,
        viewsKnown: tweet.viewsKnown,
        likes: tweet.likes,
        retweets: tweet.retweets,
        replies: tweet.replies,
        quotes: tweet.quotes,
        bookmarks: tweet.bookmarks,
        matchReason,
      }),
    ),
    tokenPosts: tokenPostResults.slice(0, 8),
    notes: [
      "Price changes are measured after publication timestamps and do not prove causation.",
      "Token-post matching uses strict cashtag/hashtag or contract-address matches.",
      "Price coverage depends on available Pump.fun candle history.",
    ],
  };

  CACHE.set(cacheKey, { ts: Date.now(), data });

  return NextResponse.json(data);
}
