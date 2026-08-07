import { createHash } from 'node:crypto';
import { z } from 'zod';
import { analyzeMentions } from '@/server/xanalysis/analytics.js';
import { analyzeAccountNetwork } from '@/server/xanalysis/network.js';
import { byInfluence, xSearchUrl, type XMention } from '@/server/xanalysis/xsearch.js';
import { classifyXLink, fetchPumpToken, SOLANA_ADDRESS_REGEX } from '@/server/xanalysis/pumpfun.js';
import { getProvider } from '@/server/providers/index.js';
import { getToken, listTokens, recordSnapshot, removeToken, upsertToken } from './tokenRepository.js';
import { pool } from '@/server/db/pool.js';
import { env } from '@/server/config/env.js';
import { cacheGet, cacheHealth, cacheSet } from '@/server/cache/redis.js';

const CASHTAG = '$';
export const addressSchema = z.string().trim().regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address');
const provider = getProvider();
const inFlight = new Map<string, Promise<SearchMentionsResult>>();

type SearchExecutionOptions = { bypassCache?: boolean; includeRaw?: boolean };
type SearchMentionsResult = Awaited<ReturnType<typeof executeSearch>>;

function serializeMention(mention: XMention) {
  return { ...mention, createdAt: mention.createdAt, author: { ...mention.author, joinedAt: mention.author.joinedAt } };
}
function dedupeAuthors(mentions: XMention[]) {
  const map = new Map<string, { author: XMention['author']; count: number; engagement: number }>();
  for (const mention of mentions) {
    const key = mention.author.handle.toLowerCase(); const existing = map.get(key);
    if (existing) { existing.count += 1; existing.engagement += mention.engagement; }
    else map.set(key, { author: mention.author, count: 1, engagement: mention.engagement });
  }
  return [...map.values()].sort((a, b) => b.author.followers - a.author.followers || b.engagement - a.engagement).slice(0, 12).map((entry) => ({
    handle: entry.author.handle, name: entry.author.name, profileUrl: entry.author.profileUrl, avatarUrl: entry.author.avatarUrl,
    followers: entry.author.followers, following: entry.author.following, totalPosts: entry.author.posts,
    isVerified: entry.author.isVerified, verifiedType: entry.author.verifiedType, joinedAt: entry.author.joinedAt,
    mentionCount: entry.count, engagement: entry.engagement,
  }));
}
function communityLinks(mentions: XMention[]) {
  const found = new Map<string, { url: string; id: string; postedBy: string; postUrl: string }>();
  for (const mention of mentions) for (const raw of mention.text.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const link = classifyXLink(raw.replace(/[),.;!?\]]+$/, ''));
    if (link?.kind === 'community' && link.ref && !found.has(link.ref)) {
      found.set(link.ref, { url: link.url, id: link.ref, postedBy: mention.author.handle, postUrl: mention.url });
    }
  }
  return [...found.values()];
}
async function step(label: string, query: string) {
  const result = await provider.search(query, { limit: env.MAX_SEARCH_RESULTS });
  const mentions = [...result.mentions].sort(byInfluence);
  return {
    label, query, searchUrl: xSearchUrl(query), total: mentions.length, truncated: result.truncated,
    mentions: mentions.map(serializeMention), topAuthors: dedupeAuthors(mentions), raw: mentions,
  };
}
function cacheKey(address: string, ticker: string) {
  const input = `${provider.name}|${address.toLowerCase()}|${ticker.toLowerCase()}|${env.SEARCH_PAGES}|v3.2`;
  return `analysis:v3.2:${createHash('sha256').update(input).digest('hex')}`;
}

async function executeSearch(address: string, ticker: string, includeRaw: boolean) {
  try {
    const [addressStep, tickerStep] = await Promise.all([
      step('Contract address', `"${address}"`),
      ticker ? step('Ticker', CASHTAG + ticker) : Promise.resolve(null),
    ]);
    const raw = [...addressStep.raw, ...(tickerStep?.raw ?? [])];
    const uniqueRaw = [...new Map(raw.map((mention) => [mention.id, mention])).values()];
    const idsAddress = new Set(addressStep.raw.map((mention) => mention.id));
    const idsTicker = new Set(tickerStep?.raw.map((mention) => mention.id) ?? []);
    let overlap = 0; let tickerOnly = 0;
    for (const id of idsTicker) { if (idsAddress.has(id)) overlap += 1; else tickerOnly += 1; }
    const network = analyzeAccountNetwork(uniqueRaw, {
      address, symbol: ticker || null,
      maxCandidatePairs: env.ANALYSIS_MAX_CANDIDATE_PAIRS,
      maxFeatureFanout: env.ANALYSIS_MAX_FEATURE_FANOUT,
      timeBucketMinutes: env.ANALYSIS_TIME_BUCKET_MINUTES,
    });
    const result = {
      status: 'ok' as const, address, symbol: ticker || null, provider: provider.name,
      steps: [addressStep, tickerStep].filter(Boolean).map(({ raw: _raw, ...value }: any) => value),
      communityLinks: communityLinks(uniqueRaw),
      analysis: analyzeMentions(uniqueRaw, { truncated: addressStep.truncated || Boolean(tickerStep?.truncated) }),
      network,
      performance: {
        networkMs: network.analysisMs,
        candidatePairs: network.candidatePairCount,
        possiblePairs: network.possiblePairCount,
        prunedPairShare: network.pruningRatio,
      },
      queryBreakdown: {
        addressPosts: idsAddress.size, tickerPosts: idsTicker.size, overlapPosts: overlap,
        tickerOnlyPosts: tickerOnly, tickerOnlyShare: idsTicker.size ? tickerOnly / idsTicker.size : 0,
      },
      ...(includeRaw ? { rawMentions: uniqueRaw } : {}),
    };
    return result;
  } catch (error) {
    return { status: 'error' as const, message: error instanceof Error ? error.message : 'Search failed' };
  }
}

export async function searchMentions(input: unknown, options: SearchExecutionOptions = {}) {
  const { address, symbol } = z.object({ address: addressSchema, symbol: z.string().trim().max(32).optional() }).parse(input);
  if (!provider.isConfigured()) return { status: 'no_key' as const };
  const ticker = (symbol ?? '').replace(/^\$/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
  const key = cacheKey(address, ticker);
  if (!options.bypassCache && !options.includeRaw) {
    const cached = await cacheGet<SearchMentionsResult>(key);
    if (cached) return { ...cached, cache: 'hit' as const };
  }
  const existing = inFlight.get(key);
  if (existing && !options.includeRaw) return { ...(await existing), cache: 'shared' as const };
  const promise = executeSearch(address, ticker, Boolean(options.includeRaw));
  if (!options.includeRaw) inFlight.set(key, promise);
  try {
    const result = await promise;
    if (result.status === 'ok' && !options.includeRaw) await cacheSet(key, result, env.SEARCH_CACHE_SECONDS);
    return { ...result, cache: 'miss' as const };
  } finally {
    if (!options.includeRaw) inFlight.delete(key);
  }
}

export function searchStatus() { return { configured: provider.isConfigured(), provider: provider.name, cacheSeconds: env.SEARCH_CACHE_SECONDS }; }
export async function lookupToken(input: unknown) {
  const { address } = z.object({ address: addressSchema }).parse(input); let pump;
  try { pump = await fetchPumpToken(address); } catch (error) { return { status: 'error' as const, message: error instanceof Error ? error.message : 'pump.fun lookup failed' }; }
  if (!pump) return { status: 'not_found' as const, address };
  const existing = await getToken(address);
  return { status: 'found' as const, isWatched: Boolean(existing), watchedId: existing?.id ?? null, token: {
    mintAddress: pump.mintAddress, symbol: pump.symbol, name: pump.name, description: pump.description, imageUri: pump.imageUri,
    xUrl: pump.xLink?.url ?? null, xLinkKind: pump.xLink?.kind ?? null, xLinkRef: pump.xLink?.ref ?? null,
    communityUrl: pump.communityUrl, website: pump.website, creator: pump.creator, usdMarketCap: pump.usdMarketCap,
    athUsdMarketCap: pump.athUsdMarketCap, replyCount: pump.replyCount, isComplete: pump.isComplete, launchedAt: pump.createdAt,
  } };
}
export async function addToken(input: unknown) {
  const { address } = z.object({ address: addressSchema }).parse(input); const pump = await fetchPumpToken(address);
  if (!pump) throw new Error('Token not found on pump.fun');
  const id = await upsertToken({ mintAddress: pump.mintAddress, symbol: pump.symbol, name: pump.name, description: pump.description,
    imageUri: pump.imageUri, website: pump.website, xUrl: pump.xLink?.url ?? null, xLinkKind: pump.xLink?.kind ?? null,
    communityUrl: pump.communityUrl, creator: pump.creator, launchedAt: pump.createdAt, usdMarketCap: pump.usdMarketCap,
    athUsdMarketCap: pump.athUsdMarketCap });
  return { id, mintAddress: pump.mintAddress, symbol: pump.symbol };
}
export async function refreshMetadata(input: unknown) { return addToken(input); }
export async function tokenDetail(input: unknown) {
  const { address } = z.object({ address: addressSchema }).parse(input); const token = await getToken(address);
  if (!token) return null; const all = await listTokens();
  return { ...token, rank: all.findIndex((entry) => entry.mintAddress === address) + 1, watchlistSize: all.length, totalMentions: all.reduce((sum, entry) => sum + entry.mentions, 0) };
}
export { listTokens, removeToken, recordSnapshot };
export async function health() {
  const started = performance.now(); await pool.query('SELECT 1');
  return { status: 'ok', provider: provider.name, database: 'ok', redis: await cacheHealth(), databaseLatencyMs: performance.now() - started };
}
