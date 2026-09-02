import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

const PAID_ROUTE_PREFIXES = [
  "/api/trade",
  "/api/database",
];

const HEAVY_ROUTE_PREFIXES = [
  "/api/trade/analyze",
  "/api/trade/analyze-stream",
  "/api/trade/dev-forensics",
  "/api/trade/creator-fee",
  "/api/miniapp/create-invoice",
  "/api/miniapp/verify-payment",
];

const HEAVY_LIMIT = 30;
const HEAVY_WINDOW_MS = 60_000;
const MAX_HEAVY_KEYS = 20_000;
const heavyRequests = new Map<string, { count: number; resetAt: number }>();

const BROWSER_CONNECT_ORIGINS = [
  "https://gmgn.ai",
  "https://pumpportal.fun",
  "https://uploads.pinata.cloud",
  "https://api.mainnet-beta.solana.com",
  "https://api.devnet.solana.com",
  "https://api.testnet.solana.com",
  "https://*.helius-rpc.com",
  "wss://*.helius-rpc.com",
  "wss://api.mainnet-beta.solana.com",
  "wss://api.devnet.solana.com",
] as const;

function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string): string {
  const isDevelopment = process.env.NODE_ENV !== "production";
  const configuredConnectOrigins = [
    process.env.NEXT_PUBLIC_BACKEND_URL,
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
    process.env.NEXT_PUBLIC_RPC_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_FRONTEND_URL,
  ]
    .map(configuredOrigin)
    .filter((value): value is string => Boolean(value));

  const connectSources = Array.from(new Set([
    "'self'",
    ...BROWSER_CONNECT_ORIGINS,
    ...configuredConnectOrigins,
  ]));

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'self' https://t.me",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function applyCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

function clientIp(request: NextRequest): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp && realIp.length <= 64) return realIp;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded?.[0] || "unknown";
}

function checkHeavyRateLimit(request: NextRequest, pathname: string): NextResponse | null {
  if (!HEAVY_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return null;
  }

  const now = Date.now();
  const ip = clientIp(request);
  const key = `${ip}:${Math.floor(now / HEAVY_WINDOW_MS)}`;
  const resetAt = (Math.floor(now / HEAVY_WINDOW_MS) + 1) * HEAVY_WINDOW_MS;
  const current = heavyRequests.get(key);

  if (!current) {
    if (heavyRequests.size >= MAX_HEAVY_KEYS) {
      for (const [candidate, entry] of heavyRequests) {
        if (entry.resetAt <= now) heavyRequests.delete(candidate);
      }
    }
    if (heavyRequests.size >= MAX_HEAVY_KEYS) {
      const oldest = heavyRequests.keys().next().value as string | undefined;
      if (oldest) heavyRequests.delete(oldest);
    }
    heavyRequests.set(key, { count: 1, resetAt });
    return null;
  }

  if (current.count >= HEAVY_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return NextResponse.json(
      { error: "Too many requests", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  current.count += 1;
  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = buildCsp(nonce);

  if (pathname === "/" && searchParams.has("api")) {
    const safeUrl = request.nextUrl.clone();
    safeUrl.searchParams.delete("api");
    return applyCsp(NextResponse.redirect(safeUrl), csp);
  }

  const heavyLimitError = checkHeavyRateLimit(request, pathname);
  if (heavyLimitError) return applyCsp(heavyLimitError, csp);

  if (PAID_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const authError = await requireProdAuth(request);
    if (authError) return applyCsp(authError, csp);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  if (PAID_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }
  return applyCsp(response, csp);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
