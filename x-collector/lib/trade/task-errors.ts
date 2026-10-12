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
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof CollectorHttpError ? error.status : Number(message.match(/(?:HTTP\s*|status\s*[:=]?\s*)(\d{3})/i)?.[1]);
  if (status === 429 || /rate.limit|temporarily limited/i.test(message))
    return { code: "RATE_LIMIT", permanent: false, retryAfterMs: error instanceof CollectorHttpError ? error.retryAfterMs : 0 };
  if (status === 401 || /auth.required|login required|session expired|invalid encrypted browser storage state/i.test(message))
    return { code: "AUTH_EXPIRED", permanent: false, retryAfterMs: 0 };
  if (status === 403 || /captcha|challenge/i.test(message))
    return { code: "ACCESS_REQUIRED", permanent: false, retryAfterMs: 0 };
  if (/^schema:|malformed|unsupported.*(kind|type)|invalid.*payload/i.test(message))
    return { code: "INVALID_INPUT", permanent: true, retryAfterMs: 0 };
  return { code: status >= 500 ? "UPSTREAM_UNAVAILABLE" : "TRANSIENT_FAILURE", permanent: false, retryAfterMs: 0 };
}
