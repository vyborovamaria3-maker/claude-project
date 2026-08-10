import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

const PAID_ROUTE_PREFIXES = [
  "/api/trade/dev-twitter",
];

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
    "https://api.mainnet-beta.solana.com",
    "https://api.devnet.solana.com",
    "https://api.testnet.solana.com",
    "https://*.helius-rpc.com",
    "wss://*.helius-rpc.com",
    "wss://api.mainnet-beta.solana.com",
    "wss://api.devnet.solana.com",
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

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = buildCsp(nonce);

  if (pathname === "/" && searchParams.has("api")) {
    const safeUrl = request.nextUrl.clone();
    safeUrl.searchParams.delete("api");
    return applyCsp(NextResponse.redirect(safeUrl), csp);
  }

  if (PAID_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const authError = await requireProdAuth(request);
    if (authError) return applyCsp(authError, csp);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  return applyCsp(
    NextResponse.next({
      request: { headers: requestHeaders },
    }),
    csp,
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
