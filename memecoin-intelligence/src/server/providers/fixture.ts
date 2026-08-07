import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '@/server/config/env.js';
import type { SocialDataProvider } from './types.js';
import type { XMention } from '@/server/xanalysis/xsearch.js';
import { extractPostFeatures } from '@/server/xanalysis/features.js';

type IndexedMention = { mention: XMention; lowerText: string };
type FixtureIndex = { mtimeMs: number; rows: IndexedMention[]; exact: Map<string, number[]> };
let cache: FixtureIndex | null = null;
let loading: Promise<FixtureIndex> | null = null;

function finiteCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalize(raw: any): XMention {
  const id = String(raw.id ?? crypto.randomUUID());
  const handle = String(raw.author?.handle ?? raw.author?.username ?? `unknown_${id}`).toLowerCase();
  const likes = finiteCount(raw.likes);
  const retweets = finiteCount(raw.retweets ?? raw.reposts);
  const replies = finiteCount(raw.replies);
  const quotes = finiteCount(raw.quotes);
  return {
    id,
    url: String(raw.url ?? `https://x.com/${handle}/status/${id}`),
    text: String(raw.text ?? ''),
    createdAt: validDate(raw.createdAt),
    likes,
    retweets,
    replies,
    quotes,
    views: finiteCount(raw.views),
    engagement: finiteCount(raw.engagement ?? likes + retweets + replies + quotes),
    author: {
      handle,
      name: String(raw.author?.name ?? handle),
      profileUrl: String(raw.author?.profileUrl ?? `https://x.com/${handle}`),
      avatarUrl: raw.author?.avatarUrl ? String(raw.author.avatarUrl) : null,
      followers: finiteCount(raw.author?.followers),
      following: finiteCount(raw.author?.following),
      posts: finiteCount(raw.author?.posts),
      isVerified: Boolean(raw.author?.isVerified),
      verifiedType: raw.author?.verifiedType ? String(raw.author.verifiedType) : null,
      bio: raw.author?.bio ? String(raw.author.bio) : null,
      joinedAt: validDate(raw.author?.joinedAt),
    },
  };
}

function addIndex(index: Map<string, number[]>, key: string, row: number) {
  if (!key) return;
  const values = index.get(key);
  if (values) values.push(row); else index.set(key, [row]);
}

async function loadIndex(): Promise<FixtureIndex> {
  const path = resolve(env.FIXTURE_PATH);
  const info = await stat(path);
  if (cache?.mtimeMs === info.mtimeMs) return cache;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Fixture file must contain a JSON array');
  const rows = parsed.map((raw) => {
    const mention = normalize(raw);
    return { mention, lowerText: mention.text.toLowerCase() };
  });
  const exact = new Map<string, number[]>();
  rows.forEach(({ mention }, row) => {
    const features = extractPostFeatures(mention.text);
    for (const value of features.contracts) addIndex(exact, value.toLowerCase(), row);
    for (const value of features.tickers) addIndex(exact, value.toLowerCase(), row);
    for (const value of features.hashtags) addIndex(exact, value.toLowerCase(), row);
    for (const value of features.words) addIndex(exact, value.toLowerCase(), row);
  });
  cache = { mtimeMs: info.mtimeMs, rows, exact };
  return cache;
}

async function index(): Promise<FixtureIndex> {
  if (!loading) loading = loadIndex().finally(() => { loading = null; });
  return loading;
}

export class FixtureProvider implements SocialDataProvider {
  readonly name = 'fixture';
  isConfigured() { return true; }

  async search(query: string, options: { limit?: number } = {}) {
    const data = await index();
    const needle = query.replace(/^"|"$/g, '').replace(/^\$/, '').trim().toLowerCase();
    const limit = Math.min(options.limit ?? env.MAX_SEARCH_RESULTS, env.MAX_SEARCH_RESULTS);
    const exactRows = data.exact.get(needle);
    const source = exactRows ? exactRows.map((row) => data.rows[row]) : data.rows;
    const mentions: XMention[] = [];
    for (const row of source) {
      if (!exactRows && !row.lowerText.includes(needle)) continue;
      mentions.push(row.mention);
      if (mentions.length >= limit) break;
    }
    return { mentions, truncated: source.length > mentions.length && mentions.length >= limit, provider: this.name };
  }
}
