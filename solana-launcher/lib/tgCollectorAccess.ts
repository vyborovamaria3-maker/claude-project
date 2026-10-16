import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_READ = 120;
const RATE_LIMIT_MUTATION = 30;
const rateBuckets = new Map<string, { startedAt: number; count: number }>();

function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip") || "local").slice(0, 128);
}

function rateLimit(request: NextRequest, mutation: boolean, providedToken: string): NextResponse | null {
  const limit = mutation ? RATE_LIMIT_MUTATION : RATE_LIMIT_READ;
  const tokenKey = createHash("sha256").update(providedToken, "utf8").digest("hex").slice(0, 16);
  const key = (mutation ? "m:" : "r:") + clientAddress(request) + ":" + tokenKey;
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    if (rateBuckets.size > 4096) {
      for (const [bucketKey, bucket] of rateBuckets) {
        if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(bucketKey);
      }
    }
    return null;
  }
  current.count += 1;
  if (current.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - current.startedAt)) / 1000));
    return NextResponse.json(
      { error: "TG Collector rate limit exceeded" },
      {
        status: 429,
        headers: {
          ...noStore,
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }
  return null;
}

/** Test-only reset hook; production code never calls this. */
export function resetTgCollectorRateLimitForTests(): void {
  rateBuckets.clear();
}

export function guardTgCollector(request: NextRequest, mutation = false): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({error:"Not found"}, {status:404,headers:noStore});
  }
  const host = request.nextUrl.hostname.toLowerCase();
  const incomingHost = (request.headers.get("host") ?? "").toLowerCase();
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
  const headerIsLoopback = allowedHosts.some((value) =>
    incomingHost === value || (incomingHost.startsWith(value + ":") &&
      /^[0-9]{1,5}$/.test(incomingHost.slice(value.length + 1))));

  if (!["localhost","127.0.0.1","::1","[::1]"].includes(host) ||
      !headerIsLoopback) {
    return NextResponse.json({error:"Localhost only"}, {status:403,headers:noStore});
  }
  if (mutation && request.headers.get("origin") !== request.nextUrl.origin) {
    return NextResponse.json({error:"Same-origin request required"}, {status:403,headers:noStore});
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const limited = rateLimit(request, mutation, provided);
  if (limited) return limited;

  const secret = process.env.TG_COLLECTOR_ADMIN_TOKEN;
  if (!secret || secret.length < 24) {
    return NextResponse.json({
      error:"Configure TG_COLLECTOR_ADMIN_TOKEN (at least 24 characters) in solana-launcher/.env.local",
    }, {status:503,headers:noStore});
  }
  // Hash both inputs to avoid leaking matching prefix or secret length.
  const expectedHash = createHash("sha256").update(secret,"utf8").digest();
  const providedHash = createHash("sha256").update(provided,"utf8").digest();
  if (!provided || !timingSafeEqual(expectedHash,providedHash)) {
    return NextResponse.json({error:"TG Collector access key required"}, {status:401,headers:noStore});
  }
  return null;
}
