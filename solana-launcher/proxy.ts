import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

const PAID_ROUTE_PREFIXES = [
  "/api/trade/dev-twitter",
];

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  // Never let a URL query parameter select the credential destination used by
  // the first-party landing page. The component itself is same-origin only as
  // well; this redirect is a second, URL-level defense.
  if (pathname === "/" && searchParams.has("api")) {
    const safeUrl = request.nextUrl.clone();
    safeUrl.searchParams.delete("api");
    return NextResponse.redirect(safeUrl);
  }

  if (PAID_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const authError = await requireProdAuth(request);
    if (authError) return authError;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/api/trade/dev-twitter/:path*"],
};
