import { NextRequest, NextResponse } from "next/server";
import { guardTgCollector } from "@/lib/tgCollectorAccess";
import { TG_COOKIE, TG_COOKIE_PATH, TG_SESSION_SECONDS, browserRequestOrigin, createBrowserSession, localAutoConnectAllowed } from "@/lib/tgCollectorBrowserSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const origin = browserRequestOrigin(request.nextUrl.protocol, request.headers.get("host") ?? "");
  if (!localAutoConnectAllowed(process.env.TG_COLLECTOR_LOCAL_AUTO_CONNECT,
    process.env.TG_COLLECTOR_LOCAL_ORIGIN, origin, process.env.NODE_ENV === "production")) {
    return NextResponse.json({ error: "Local auto-connect is unavailable" }, { status: 404, headers: noStore });
  }
  if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") !== "same-origin") {
    return NextResponse.json({ error: "Same-origin browser request required" }, { status: 403, headers: noStore });
  }
  // Use the existing host, origin and rate checks. No server key is sent to the browser.
  const trusted = new NextRequest(request.url, { method: "POST", headers: request.headers });
  trusted.headers.set("authorization", "Bearer " + (process.env.TG_COLLECTOR_ADMIN_TOKEN ?? ""));
  const forbidden = guardTgCollector(trusted, true);
  if (forbidden) return forbidden;
  const response = NextResponse.json({ connected: true }, { headers: noStore });
  response.cookies.set(TG_COOKIE, createBrowserSession(process.env.TG_COLLECTOR_ADMIN_TOKEN!, origin), {
    httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:",
    path: TG_COOKIE_PATH, maxAge: TG_SESSION_SECONDS,
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  const forbidden = guardTgCollector(request, true);
  if (forbidden) return forbidden;
  const response = NextResponse.json({ connected: false }, { headers: noStore });
  response.cookies.set(TG_COOKIE, "", { httpOnly: true, sameSite: "strict", path: TG_COOKIE_PATH, maxAge: 0 });
  return response;
}
