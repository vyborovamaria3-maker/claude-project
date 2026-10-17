import { NextRequest, NextResponse } from "next/server";
import {
  checkTgCollectorAccess,
  resetTgCollectorRateLimitForTests,
} from "./tgCollectorAccessCore";

import { TG_COOKIE, browserRequestOrigin, localAutoConnectAllowed, validBrowserSession } from "./tgCollectorBrowserSession";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export { resetTgCollectorRateLimitForTests };

function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip") || "local").slice(0, 128);
}

export function guardTgCollector(request: NextRequest, mutation = false): NextResponse | null {
  const secret = process.env.TG_COLLECTOR_ADMIN_TOKEN;
  const externalOrigin = browserRequestOrigin(request.nextUrl.protocol, request.headers.get("host") ?? "");
  const localSession = localAutoConnectAllowed(process.env.TG_COLLECTOR_LOCAL_AUTO_CONNECT,
    process.env.TG_COLLECTOR_LOCAL_ORIGIN, externalOrigin, process.env.NODE_ENV === "production")
    && Boolean(secret && validBrowserSession(request.cookies.get(TG_COOKIE)?.value, secret, externalOrigin));
  const decision = checkTgCollectorAccess({
    hostname: request.nextUrl.hostname,
    hostHeader: request.headers.get("host") ?? "",
    origin: request.headers.get("origin"),
    requestOrigin: request.nextUrl.origin,
    mutation,
    providedToken: (() => {
      if (localSession) return secret!;
      const header = request.headers.get("authorization") ?? "";
      return header.startsWith("Bearer ") ? header.slice(7) : "";
    })(),
    secret: process.env.TG_COLLECTOR_ADMIN_TOKEN,
    production: process.env.NODE_ENV === "production",
    clientAddress: clientAddress(request),
  });
  if (decision.ok) return null;
  return NextResponse.json(
    { error: decision.error },
    { status: decision.status, headers: { ...noStore, ...(decision.headers ?? {}) } },
  );
}
