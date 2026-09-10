import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BACKEND_URL = "http://localhost:8000";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_QUERY_KEYS = new Set([
  "platform",
  "hours",
  "sources",
  "explicit_calls_only",
  "min_engagement",
  "min_channel_score",
  "limit",
]);

function backendBaseUrl() {
  return (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, "");
}

function upstreamHeaders(request: NextRequest): Headers {
  const headers = new Headers({ Accept: "application/json" });
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("Authorization", authorization);

  const sessionCookie = request.cookies.get("potapoff_access_token")?.value;
  if (sessionCookie) headers.set("Cookie", `potapoff_access_token=${encodeURIComponent(sessionCookie)}`);
  return headers;
}

function passThrough(response: Response, body: string) {
  return new NextResponse(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

export async function GET(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get("kind") || "token";

  try {
    let url: URL;

    if (kind === "token") {
      const mint = request.nextUrl.searchParams.get("mint")?.trim() || "";
      if (!MINT_RE.test(mint)) {
        return NextResponse.json({ detail: "Invalid Solana mint address" }, { status: 400 });
      }

      url = new URL(`${backendBaseUrl()}/api/v1/social/token/${encodeURIComponent(mint)}`);
      for (const [key, value] of request.nextUrl.searchParams.entries()) {
        if (TOKEN_QUERY_KEYS.has(key)) url.searchParams.set(key, value);
      }
    } else if (kind === "channels") {
      url = new URL(`${backendBaseUrl()}/api/v1/telegram/channels`);
      const limit = request.nextUrl.searchParams.get("limit") || "100";
      const offset = request.nextUrl.searchParams.get("offset") || "0";
      url.searchParams.set("limit", limit);
      url.searchParams.set("offset", offset);
    } else {
      return NextResponse.json({ detail: "Unsupported social source" }, { status: 400 });
    }

    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: upstreamHeaders(request),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    return passThrough(response, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backend unavailable";
    return NextResponse.json({ detail: `Social backend unavailable: ${message}` }, { status: 503 });
  }
}
