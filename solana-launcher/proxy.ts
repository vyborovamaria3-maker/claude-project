import { NextRequest, NextResponse } from "next/server";

const ACCESS_COOKIE = "potapoff_access_token";
const PUBLIC_PATHS = new Set(["/", "/login", "/auth", "/miniapp"]);
const AUTH_TIMEOUT_MS = 5_000;

function backendBaseUrl() {
  return process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";
}

function clearCookieAndRedirect(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete(ACCESS_COOKIE);
  return response;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) {
    return clearCookieAndRedirect(request);
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
    if (response.status === 401 || response.status === 403) {
      return clearCookieAndRedirect(request);
    }
    return new NextResponse("Authentication service unavailable", { status: 503 });
  } catch {
    return new NextResponse("Authentication service unavailable", { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

export const config = {
  matcher: [
    "/((?!api|fastapi|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
