import { NextRequest, NextResponse } from "next/server";

const ACCESS_COOKIE = "potapoff_access_token";
const PUBLIC_PATHS = new Set(["/", "/login", "/auth", "/miniapp"]);
const PUBLIC_API_PREFIXES = [
  "/api/miniapp/",
  "/api/auth/",
  "/api/v1/auth/",
  "/api/i18n/",
];
const PUBLIC_API_PATHS = new Set(["/api/telegram/webhook"]);
const AUTH_TIMEOUT_MS = 5_000;

function backendBaseUrl() {
  return process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";
}

function isPublicApi(pathname: string) {
  return PUBLIC_API_PATHS.has(pathname) || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return request.cookies.get(ACCESS_COOKIE)?.value || null;
}

function clearCookieAndRedirect(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete(ACCESS_COOKIE);
  return response;
}

function apiError(status: number, error: string) {
  const response = NextResponse.json({ error }, { status });
  if (status === 401 || status === 403) response.cookies.delete(ACCESS_COOKIE);
  return response;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");

  if ((!isApi && PUBLIC_PATHS.has(pathname)) || (isApi && isPublicApi(pathname))) {
    return NextResponse.next();
  }

  const token = bearerToken(request);
  if (!token) {
    return isApi ? apiError(401, "Unauthorized") : clearCookieAndRedirect(request);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${backendBaseUrl()}/api/v1/auth/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });

    if (response.ok) {
      return NextResponse.next();
    }
    if (response.status === 401) {
      return isApi ? apiError(401, "Unauthorized") : clearCookieAndRedirect(request);
    }
    if (response.status === 403) {
      return isApi
        ? apiError(403, "Active subscription required")
        : clearCookieAndRedirect(request);
    }
    return isApi
      ? apiError(503, "Authentication service unavailable")
      : new NextResponse("Authentication service unavailable", { status: 503 });
  } catch {
    return isApi
      ? apiError(503, "Authentication service unavailable")
      : new NextResponse("Authentication service unavailable", { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!fastapi|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
