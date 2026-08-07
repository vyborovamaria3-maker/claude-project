import type { XMention } from './xsearch.js';

const CONTRACT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const MENTION_RE = /@([A-Za-z0-9_]{1,15})/g;
const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
const TICKER_RE = /\$([A-Za-z0-9_]{1,20})/g;

const STOP_WORDS = new Set([
  'the','and','for','that','this','with','from','have','your','you','are','was','will','just','new','now','coin','token','meme','memecoin',
  'это','как','для','что','или','уже','все','при','про','токен','монета','мемкоин',
]);

export type PostFeatures = {
  contracts: string[];
  links: string[];
  mentions: string[];
  hashtags: string[];
  tickers: string[];
  words: string[];
  normalizedText: string;
  textFingerprint: string;
};

export type AccountFeatures = {
  contracts: Set<string>;
  links: Set<string>;
  mentions: Set<string>;
  hashtags: Set<string>;
  tickers: Set<string>;
  words: Set<string>;
  fingerprints: Set<string>;
};

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value.replace(/[),.;!?\]]+$/, ''));
    url.hash = '';
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) {
      url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.replace(/[),.;!?\]]+$/, '').toLowerCase();
  }
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(URL_RE, ' ')
    .replace(CONTRACT_RE, ' ')
    .replace(/[$#@][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized: string): string[] {
  return unique(
    normalized
      .split(' ')
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  );
}

// FNV-1a is intentionally cheap and deterministic. It is not cryptographic;
// it is only used to bucket equal/near-identical normalized posts.
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function extractPostFeatures(text: string): PostFeatures {
  const normalizedText = normalizeText(text);
  return {
    contracts: unique(text.match(CONTRACT_RE) ?? []),
    links: unique((text.match(URL_RE) ?? []).map(cleanUrl)),
    mentions: unique([...text.matchAll(MENTION_RE)].map((match) => match[1].toLowerCase())),
    hashtags: unique([...text.matchAll(HASHTAG_RE)].map((match) => match[1].toLowerCase())),
    tickers: unique([...text.matchAll(TICKER_RE)].map((match) => match[1].toLowerCase())),
    words: tokenize(normalizedText),
    normalizedText,
    textFingerprint: fingerprint(normalizedText),
  };
}

export function aggregateAccountFeatures(posts: XMention[]): AccountFeatures {
  const aggregate: AccountFeatures = {
    contracts: new Set(), links: new Set(), mentions: new Set(), hashtags: new Set(),
    tickers: new Set(), words: new Set(), fingerprints: new Set(),
  };
  for (const post of posts) {
    const features = extractPostFeatures(post.text);
    for (const value of features.contracts) aggregate.contracts.add(value);
    for (const value of features.links) aggregate.links.add(value);
    for (const value of features.mentions) aggregate.mentions.add(value);
    for (const value of features.hashtags) aggregate.hashtags.add(value);
    for (const value of features.tickers) aggregate.tickers.add(value);
    for (const value of features.words) aggregate.words.add(value);
    if (features.normalizedText.length >= 12) aggregate.fingerprints.add(features.textFingerprint);
  }
  return aggregate;
}
