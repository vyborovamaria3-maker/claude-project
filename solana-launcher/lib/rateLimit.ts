// Rate limiting utility for Next.js API routes.

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_RATE_LIMIT_ENTRIES = 50_000;

function cleanupExpired(now = Date.now()) {
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime <= now) rateLimitStore.delete(key);
  }
}

const cleanupTimer = setInterval(() => cleanupExpired(), 5 * 60 * 1000);
cleanupTimer.unref?.();

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

export function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowSeconds: number,
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const key = `${identifier}:${Math.floor(now / windowMs)}`;
  let entry = rateLimitStore.get(key);

  if (!entry) {
    if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) cleanupExpired(now);
    if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimitStore.keys().next().value as string | undefined;
      if (oldestKey) rateLimitStore.delete(oldestKey);
    }

    const resetTime = (Math.floor(now / windowMs) + 1) * windowMs;
    entry = { count: 1, resetTime };
    rateLimitStore.set(key, entry);
    return {
      success: true,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - 1),
      reset: resetTime,
    };
  }

  if (entry.count >= maxRequests) {
    return {
      success: false,
      limit: maxRequests,
      remaining: 0,
      reset: entry.resetTime,
      retryAfter: Math.max(1, Math.ceil((entry.resetTime - now) / 1000)),
    };
  }

  entry.count += 1;
  return {
    success: true,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    reset: entry.resetTime,
  };
}

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) return null;
  return normalized;
}

/** Resolve the address written by the trusted production ingress. */
export function getClientIp(request: Request): string {
  const realIp = normalizeIp(request.headers.get("x-real-ip"));
  if (realIp) return realIp;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((part) => normalizeIp(part))
      .filter((part): part is string => Boolean(part));
    const ingressPeer = hops.at(-1);
    if (ingressPeer) return ingressPeer;
  }

  return "unknown";
}

export function withRateLimit(
  handler: (req: Request) => Promise<Response> | Response,
  options: {
    maxRequests: number;
    windowSeconds: number;
    getIdentifier?: (req: Request) => string;
  },
) {
  return async function rateLimitedHandler(req: Request): Promise<Response> {
    const identifier = options.getIdentifier ? options.getIdentifier(req) : getClientIp(req);
    const result = checkRateLimit(identifier, options.maxRequests, options.windowSeconds);

    if (!result.success) {
      return new Response(
        JSON.stringify({ error: "Too many requests", retryAfter: result.retryAfter }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": String(result.remaining),
            "X-RateLimit-Reset": String(result.reset),
            "Retry-After": String(result.retryAfter || 60),
          },
        },
      );
    }

    const response = await handler(req);
    const newHeaders = new Headers(response.headers);
    newHeaders.set("X-RateLimit-Limit", String(result.limit));
    newHeaders.set("X-RateLimit-Remaining", String(result.remaining));
    newHeaders.set("X-RateLimit-Reset", String(result.reset));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}
