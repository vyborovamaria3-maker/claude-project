/**
 * X (Twitter) mention search via twitterapi.io.
 *
 * X's own API has no affordable search tier and does not expose Communities at
 * all, so we go through twitterapi.io — a third-party reseller that mirrors X's
 * advanced-search operator syntax, bills per returned tweet (~$0.15 / 1k) and
 * needs nothing but an `X-API-Key` header. Crucially its tweet payload embeds
 * the full author record (followers, verification, post count), so a single
 * search call answers both "who mentioned this" and "how big is that account".
 *
 * The key is read from the `xanalysis.twitterApiKey` config (type `secret`).
 * When it is unset every call returns `{ status: 'no_key' }` so the UI can say
 * so plainly instead of pretending there is no chatter.
 */
 
import { env } from '@/server/config/env.js';
 
const API_BASE = 'https://api.twitterapi.io';
const REQUEST_TIMEOUT_MS = 15_000;
 
export type XAuthor = {
  handle: string;
  name: string;
  profileUrl: string;
  avatarUrl: string | null;
  followers: number;
  following: number;
  posts: number;
  isVerified: boolean;
  /** e.g. "government", "business" — empty for plain Blue. */
  verifiedType: string | null;
  bio: string | null;
  joinedAt: Date | null;
};
 
export type XMention = {
  id: string;
  url: string;
  text: string;
  createdAt: Date | null;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  views: number;
  /** Likes + retweets + replies + quotes — used for ordering. */
  engagement: number;
  author: XAuthor;
};
 
export type XSearchResult = {
  /** The raw advanced-search query we sent, so the UI can deep-link to X. */
  query: string;
  mentions: XMention[];
  /** True when twitterapi.io reported more pages than we fetched. */
  truncated: boolean;
};
 
type RawAuthor = {
  userName?: unknown;
  name?: unknown;
  url?: unknown;
  profilePicture?: unknown;
  followers?: unknown;
  following?: unknown;
  statusesCount?: unknown;
  isBlueVerified?: unknown;
  verifiedType?: unknown;
  description?: unknown;
  createdAt?: unknown;
};
 
type RawTweet = {
  id?: unknown;
  url?: unknown;
  text?: unknown;
  createdAt?: unknown;
  likeCount?: unknown;
  retweetCount?: unknown;
  replyCount?: unknown;
  quoteCount?: unknown;
  viewCount?: unknown;
  author?: RawAuthor;
};
 
type RawResponse = {
  tweets?: RawTweet[];
  has_next_page?: unknown;
  next_cursor?: unknown;
  message?: unknown;
};

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function countValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return false;
}
 
/** Empty string / whitespace configs count as "not configured". */
export function getXSearchApiKey(): string | null {
  const key = env.TWITTERAPI_IO_KEY;
  if (typeof key !== 'string') {
    return null;
  }
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}
 
export function isXSearchConfigured(): boolean {
  return getXSearchApiKey() !== null;
}
 
/** X serves "Tue Dec 10 07:00:30 +0000 2024" — Date can parse it, but guard anyway. */
function parseXDate(value: unknown): Date | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
 
function mapAuthor(raw: RawAuthor | undefined, fallbackHandle: string): XAuthor {
  const handle = stringValue(raw?.userName) ?? fallbackHandle;
  return {
    handle,
    name: stringValue(raw?.name) ?? handle,
    profileUrl: stringValue(raw?.url) ?? `https://x.com/${handle}`,
    avatarUrl: stringValue(raw?.profilePicture),
    followers: countValue(raw?.followers),
    following: countValue(raw?.following),
    posts: countValue(raw?.statusesCount),
    isVerified: booleanValue(raw?.isBlueVerified),
    verifiedType: stringValue(raw?.verifiedType),
    bio: stringValue(raw?.description),
    joinedAt: parseXDate(raw?.createdAt),
  };
}
 
function mapTweet(raw: RawTweet): XMention | null {
  const id = stringValue(raw.id);
  if (!id) {
    return null;
  }
  const likes = countValue(raw.likeCount);
  const retweets = countValue(raw.retweetCount);
  const replies = countValue(raw.replyCount);
  const quotes = countValue(raw.quoteCount);
  // Do not collapse every tweet with missing author data into one fake account.
  // A per-tweet fallback preserves graph integrity while clearly marking bad upstream data.
  const author = mapAuthor(raw.author, `unknown_${id}`);
 
  return {
    id,
    url: stringValue(raw.url) ?? `https://x.com/${author.handle}/status/${id}`,
    text: stringValue(raw.text) ?? '',
    createdAt: parseXDate(raw.createdAt),
    likes,
    retweets,
    replies,
    quotes,
    views: countValue(raw.viewCount),
    engagement: likes + retweets + replies + quotes,
    author,
  };
}
 
/**
 * Run one advanced-search query.
 *
 * `pages` caps how many 20-tweet pages we pull — this is a direct cost control,
 * so keep it small. Results are deduplicated by tweet id (pagination can
 * overlap) and never include ads, which twitterapi.io filters upstream.
 */
async function searchXUncached(
  query: string,
  {
    queryType = 'Latest',
    pages = 1,
  }: { queryType?: 'Latest' | 'Top'; pages?: number } = {}
): Promise<XSearchResult> {
  const apiKey = getXSearchApiKey();
  if (!apiKey) {
    throw new Error('X search API key is not configured');
  }
 
  const collected = new Map<string, XMention>();
  let cursor = '';
  let hasNextPage = false;
 
  for (let page = 0; page < Math.max(1, pages); page += 1) {
    const url = new URL('/twitter/tweet/advanced_search', API_BASE);
    url.searchParams.set('query', query);
    url.searchParams.set('queryType', queryType);
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }
 
    const response = await fetch(url, {
      headers: { 'X-API-Key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
 
    if (response.status === 401 || response.status === 403) {
      throw new Error('X search rejected the API key');
    }
    if (!response.ok) {
      throw new Error(`X search failed (HTTP ${response.status})`);
    }
 
    const payload = (await response.json()) as RawResponse;
    for (const raw of payload.tweets ?? []) {
      const mention = mapTweet(raw);
      if (mention) {
        collected.set(mention.id, mention);
      }
    }
 
    hasNextPage = booleanValue(payload.has_next_page);
    cursor = stringValue(payload.next_cursor) ?? '';
    if (!hasNextPage || !cursor) {
      break;
    }
  }
 
  return {
    query,
    mentions: [...collected.values()],
    truncated: hasNextPage,
  };
}
 
type SearchCacheEntry = {
  expiresAt: number;
  promise: Promise<XSearchResult>;
};

const searchCache = new Map<string, SearchCacheEntry>();

/**
 * Short server-side cache and in-flight request deduplication. The mention UI
 * can mount on multiple pages and React Query only caches per browser; without
 * this layer repeated public requests could needlessly spend provider credits.
 */
export async function searchX(
  query: string,
  {
    queryType = 'Latest',
    pages = 1,
  }: { queryType?: 'Latest' | 'Top'; pages?: number } = {}
): Promise<XSearchResult> {
  const normalizedPages = Math.max(1, Math.min(5, Math.floor(Number.isFinite(pages) ? pages : 1)));
  const ttlSeconds = Math.max(0, Math.min(300, Number(env.SEARCH_CACHE_SECONDS) || 60));
  const now = Date.now();
  const cacheKey = `${queryType}:${normalizedPages}:${query}`;
  const cached = searchCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  if (cached) searchCache.delete(cacheKey);

  const promise = searchXUncached(query, { queryType, pages: normalizedPages });
  // ttl=0 disables persistent caching but still allows this request to complete normally.
  if (ttlSeconds > 0) {
    searchCache.set(cacheKey, { expiresAt: now + ttlSeconds * 1_000, promise });
  }

  try {
    return await promise;
  } catch (error) {
    if (searchCache.get(cacheKey)?.promise === promise) searchCache.delete(cacheKey);
    throw error;
  }
}
 
/** Human-facing X search URL for the same query, for "open in X" links. */
export function xSearchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
}
 
/** Loudest accounts first — an influencer post matters more than a bot reply. */
export function byInfluence(a: XMention, b: XMention): number {
  if (b.author.followers !== a.author.followers) {
    return b.author.followers - a.author.followers;
  }
  return b.engagement - a.engagement;
}
