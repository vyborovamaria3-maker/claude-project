export class CollectorHttpError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) {
    super(`X returned HTTP ${status}`);
    this.name = "CollectorHttpError";
  }
}

export function retryAfterMs(value: string | undefined, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : 0;
}

export function taskFailure(error: unknown): { code: string; permanent: boolean; retryAfterMs: number } {
  // An uncertain database COMMIT is not evidence of X rate limits, a bad
  // authenticated session, or a network/proxy problem.
  if (error instanceof Error && error.name === "AmbiguousCommitError")
    return { code: "DB_COMMIT_UNCERTAIN", permanent: false, retryAfterMs: 60_000 };
  const message = error instanceof Error ? error.message : String(error);
  if (/^BROWSER_CHECKPOINT_CHANGED$/.test(message))
    return { code: "BROWSER_CHECKPOINT_CHANGED", permanent: true, retryAfterMs: 0 };
  if (/^(Browser checkpoint (task|account) lease lost|task lease lost before persistence|account lease lost before persistence)/.test(message))
    return { code: "ACCOUNT_LEASE_LOST", permanent: false, retryAfterMs: 5000 };
  const status = error instanceof CollectorHttpError ? error.status : Number(message.match(/(?:HTTP\s*|status\s*[:=]?\s*)(\d{3})/i)?.[1]);
  if (/^XACTIONS_ENDPOINT_UNAVAILABLE/.test(message))
    return { code: "ENDPOINT_UNAVAILABLE", permanent: false, retryAfterMs: 120_000 };
  if (/^XACTIONS_ACCESS_UNVERIFIED/.test(message))
    return { code: "ACCESS_UNVERIFIED", permanent: false, retryAfterMs: 120_000 };
  if (/^XACTIONS_ACCESS_DENIED/.test(message))
    return { code: "ACCESS_DENIED", permanent: true, retryAfterMs: 0 };
  if (status === 429 || /rate.limit|temporarily limited/i.test(message))
    return { code: "RATE_LIMIT", permanent: false, retryAfterMs: error instanceof CollectorHttpError ? error.retryAfterMs : 0 };
  if (status === 401 || /auth.required|login required|session expired|invalid encrypted browser storage state/i.test(message))
    return { code: "AUTH_EXPIRED", permanent: false, retryAfterMs: 0 };
  if (status === 403 || /captcha|challenge/i.test(message))
    return { code: "ACCESS_REQUIRED", permanent: false, retryAfterMs: 0 };
  // Distinguish uncertain collection states from verified empty results or
  // broken account credentials. These are operational failures, not bans.
  if (/^TIMELINE_PARSE_UNCONFIRMED/i.test(message))
    return { code: "TIMELINE_PARSE_UNCONFIRMED", permanent: false, retryAfterMs: 120_000 };
  if (/^TIMELINE_UNCONFIRMED/i.test(message))
    return { code: "TIMELINE_UNCONFIRMED", permanent: false, retryAfterMs: 30_000 };
  if (/^SEARCH_PARSE_UNCONFIRMED/i.test(message))
    return { code: "SEARCH_PARSE_UNCONFIRMED", permanent: false, retryAfterMs: 120_000 };
  if (/^SEARCH_UNCONFIRMED|search results did not load|no tweets and no empty state/i.test(message))
    return { code: "SEARCH_UNCONFIRMED", permanent: false, retryAfterMs: 30_000 };
  if (/^BROWSER_END_UNVERIFIED/.test(message))
    return { code: "BROWSER_END_UNVERIFIED", permanent: false, retryAfterMs: 120_000 };
  if (/XActions: ambiguous timeline end/i.test(message))
    return { code: "PAGE_END_UNVERIFIED", permanent: false, retryAfterMs: 120_000 };
  if (/XACTIONS_NO_PROGRESS|pagination cursor loop|pagination did not advance/i.test(message))
    return { code: "PAGINATION_STALLED", permanent: false, retryAfterMs: 120_000 };
  if (/response shape changed|SearchTimeline endpoint unavailable/i.test(message))
    return { code: "SOURCE_SHAPE_CHANGED", permanent: false, retryAfterMs: 300_000 };
  if (/^XACTIONS_TRANSPORT_TIMEOUT/.test(message))
    return { code: "COLLECTION_TIMEOUT", permanent: false, retryAfterMs: 30_000 };
  if (/^XACTIONS_RESPONSE_INVALID/.test(message))
    return { code: "HTTP_RESPONSE_INVALID", permanent: false, retryAfterMs: 120_000 };
  if (/^XACTIONS_PROXY_AUTH_FAILED/.test(message))
    return { code: "PROXY_AUTH", permanent: false, retryAfterMs: 3_600_000 };
  if (/^XACTIONS_PROXY_DNS_FAILED/.test(message))
    return { code: "PROXY_DNS", permanent: false, retryAfterMs: 60_000 };
  if (/^XACTIONS_NETWORK_IO_UNVERIFIED/.test(message))
    return { code: "NETWORK_IO_UNVERIFIED", permanent: false, retryAfterMs: 30_000 };
  if (/^PROXY_FAILED:\s*invalid account proxy/i.test(message))
    return { code: "PROXY_CONFIG_INVALID", permanent: true, retryAfterMs: 0 };
  if (/SOCKS(?:4|5)?|PROXY_FAILED|proxy authentication|proxy connection|proxy handshake|ERR_PROXY_CONNECTION_FAILED/i.test(message))
    return { code: "PROXY_CONNECT", permanent: false, retryAfterMs: 60_000 };
  if ((error instanceof Error && error.name === "TimeoutError") ||
      /HTTP request timed out|navigation timeout|collection deadline exceeded|scrape deadline exceeded|Timeout .*exceeded/i.test(message))
    return { code: "COLLECTION_TIMEOUT", permanent: false, retryAfterMs: 30_000 };
  if (/^schema:|malformed|unsupported.*(kind|type)|invalid.*payload/i.test(message))
    return { code: "INVALID_INPUT", permanent: true, retryAfterMs: 0 };
  return { code: status >= 500 ? "UPSTREAM_UNAVAILABLE" : "TRANSIENT_FAILURE", permanent: false, retryAfterMs: 0 };
}
