import { createHash, timingSafeEqual } from "node:crypto";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_READ = 120;
const RATE_LIMIT_MUTATION = 30;
const rateBuckets = new Map<string, { startedAt: number; count: number }>();

export type TgAccessInput = {
  hostname: string;
  hostHeader: string;
  origin: string | null;
  requestOrigin: string;
  mutation: boolean;
  providedToken: string;
  secret: string | undefined;
  production: boolean;
  clientAddress: string;
};

export type TgAccessDecision =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 429 | 503; error: string; headers?: Record<string, string> };

function localHostAllowed(hostname: string, hostHeader: string): boolean {
  const host = hostname.toLowerCase();
  const incomingHost = hostHeader.toLowerCase();
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
  const headerIsLoopback = allowedHosts.some((value) =>
    incomingHost === value || (incomingHost.startsWith(value + ":") &&
      /^[0-9]{1,5}$/.test(incomingHost.slice(value.length + 1))));
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && headerIsLoopback;
}

function rateLimit(input: TgAccessInput): TgAccessDecision {
  const limit = input.mutation ? RATE_LIMIT_MUTATION : RATE_LIMIT_READ;
  const tokenKey = createHash("sha256").update(input.providedToken, "utf8").digest("hex").slice(0, 16);
  const key = (input.mutation ? "m:" : "r:") + input.clientAddress.slice(0, 128) + ":" + tokenKey;
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    if (rateBuckets.size > 4096) {
      for (const [bucketKey, bucket] of rateBuckets) {
        if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(bucketKey);
      }
    }
    return { ok: true };
  }
  current.count += 1;
  if (current.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - current.startedAt)) / 1000));
    return {
      ok: false,
      status: 429,
      error: "TG Collector rate limit exceeded",
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": "0",
      },
    };
  }
  return { ok: true };
}

export function resetTgCollectorRateLimitForTests(): void {
  rateBuckets.clear();
}

export function checkTgCollectorAccess(input: TgAccessInput): TgAccessDecision {
  if (input.production) return { ok: false, status: 404, error: "Not found" };
  if (!localHostAllowed(input.hostname, input.hostHeader)) {
    return { ok: false, status: 403, error: "Localhost only" };
  }
  // Next.js may normalize the internal loopback URL to localhost. The validated
  // Host header retains the browser-facing authority, including its port.
  let expectedOrigin: string;
  try {
    const external = new URL(input.requestOrigin);
    external.host = input.hostHeader;
    expectedOrigin = external.origin;
  } catch {
    return { ok: false, status: 403, error: "Invalid request origin" };
  }
  if (input.mutation && input.origin !== expectedOrigin) {
    return { ok: false, status: 403, error: "Same-origin request required" };
  }

  const limited = rateLimit(input);
  if (!limited.ok) return limited;

  const secret = input.secret;
  if (!secret || secret.length < 24) {
    return {
      ok: false,
      status: 503,
      error: "Configure TG_COLLECTOR_ADMIN_TOKEN (at least 24 characters) in solana-launcher/.env.local",
    };
  }

  const expectedHash = createHash("sha256").update(secret, "utf8").digest();
  const providedHash = createHash("sha256").update(input.providedToken, "utf8").digest();
  if (!input.providedToken || !timingSafeEqual(expectedHash, providedHash)) {
    return { ok: false, status: 401, error: "TG Collector access key required" };
  }
  return { ok: true };
}
