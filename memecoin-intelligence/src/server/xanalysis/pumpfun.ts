/**
 * pump.fun token metadata lookup.
 *
 * `frontend-api-v3.pump.fun` is pump.fun's own (undocumented, unauthenticated)
 * frontend API. The older `frontend-api.pump.fun` host is behind Cloudflare and
 * returns 530, so v3 is the only usable host.
 *
 * The coin payload carries a single free-form `twitter` field which token
 * creators fill with whatever X link they want. In practice it is one of:
 *   - a community:  https://x.com/i/communities/<id>
 *   - a profile:    https://x.com/<handle>
 *   - a single post: https://x.com/<handle>/status/<id>
 *   - a search URL or something unparseable
 * We classify it so the UI can surface a community group when one exists —
 * X's API does not expose communities at all, so scraping this field is the
 * only way to find a token's community without a human pasting the link.
 */
 
const PUMP_API = 'https://frontend-api-v3.pump.fun';
const REQUEST_TIMEOUT_MS = 12_000;
 
/** Solana mint addresses are base58, 32-44 chars. */
export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
 
export type XLinkKind = 'community' | 'profile' | 'post' | 'search' | 'unknown';
 
export type XLink = {
  kind: XLinkKind;
  url: string;
  /** Community id for `community`, handle for `profile`/`post`. */
  ref: string | null;
};
 
export type PumpToken = {
  mintAddress: string;
  symbol: string;
  name: string;
  description: string | null;
  imageUri: string | null;
  /** Classified X link from the coin's `twitter` field, if any. */
  xLink: XLink | null;
  /** Community URL, when the X link is a community (the case we care about). */
  communityUrl: string | null;
  website: string | null;
  creator: string | null;
  usdMarketCap: number | null;
  athUsdMarketCap: number | null;
  replyCount: number | null;
  isComplete: boolean;
  createdAt: Date | null;
};
 
/**
 * Normalizes a pump.fun `twitter` value into a classified X link.
 * Handles missing protocols, twitter.com/x.com, tracking params and trailing slashes.
 */
export function classifyXLink(raw: unknown): XLink | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
 
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
 
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }
 
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.twitter.com') {
    return null;
  }
 
  // Canonicalize onto x.com and drop tracking params (?s=20, ?t=..., etc).
  url.hostname = 'x.com';
  url.search = '';
  url.hash = '';
  const clean = url.toString().replace(/\/$/, '');
 
  const segments = url.pathname.split('/').filter(Boolean);
 
  const communityIndex = segments.indexOf('communities');
  if (communityIndex !== -1 && segments[communityIndex + 1]) {
    return { kind: 'community', url: clean, ref: segments[communityIndex + 1] };
  }
 
  if (segments[0] === 'search') {
    return { kind: 'search', url: clean, ref: null };
  }
 
  const statusIndex = segments.indexOf('status');
  if (statusIndex !== -1) {
    const handle = segments[0] && segments[0] !== 'i' ? segments[0] : null;
    return { kind: 'post', url: clean, ref: handle };
  }
 
  // Reserved single-segment X paths that aren't user profiles.
  const reserved = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'intent']);
  if (segments.length === 1 && !reserved.has(segments[0])) {
    return { kind: 'profile', url: clean, ref: segments[0] };
  }
 
  return { kind: 'unknown', url: clean, ref: null };
}
 
function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
 
function toDate(value: unknown): Date | null {
  const numeric = toNumber(value);
  // Upstreams commonly mix Unix seconds and milliseconds. Values below year 2001
  // in millisecond form are safely interpreted as seconds.
  const timestamp = numeric !== null && Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const date = timestamp !== null ? new Date(timestamp) : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
 
function toTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toHttpUrl(value: unknown): string | null {
  const raw = toTrimmedString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
 
/**
 * Fetches a single token by mint address.
 * Returns `null` when pump.fun doesn't know the address (404).
 * Throws on network failure or an unexpected upstream status.
 */
export async function fetchPumpToken(mintAddress: string): Promise<PumpToken | null> {
  const response = await fetch(`${PUMP_API}/coins/${encodeURIComponent(mintAddress)}`, {
    headers: {
      accept: 'application/json',
      // pump.fun rejects requests without a browser-like UA.
      'user-agent': 'Mozilla/5.0 (compatible; SignalRoom/1.0)',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
 
  if (response.status === 404) return null;
 
  if (!response.ok) {
    throw new Error(`pump.fun lookup failed (HTTP ${response.status})`);
  }
 
  const coin = (await response.json()) as Record<string, unknown>;
 
  const mint = toTrimmedString(coin.mint);
  if (!mint) return null;
 
  const xLink = classifyXLink(coin.twitter);
 
  return {
    mintAddress: mint,
    symbol: (toTrimmedString(coin.symbol) ?? '').toUpperCase(),
    name: toTrimmedString(coin.name) ?? '',
    description: toTrimmedString(coin.description),
    imageUri: toHttpUrl(coin.image_uri),
    xLink,
    communityUrl: xLink?.kind === 'community' ? xLink.url : null,
    website: toHttpUrl(coin.website),
    creator: toTrimmedString(coin.creator),
    usdMarketCap: toNumber(coin.usd_market_cap),
    athUsdMarketCap: toNumber(coin.ath_market_cap),
    replyCount: toNumber(coin.reply_count),
    isComplete: coin.complete === true,
    createdAt: toDate(coin.created_timestamp),
  };
}
