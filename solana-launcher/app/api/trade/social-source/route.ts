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

function absoluteHttpBase(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function backendBaseUrl() {
  // NEXT_PUBLIC_BACKEND_URL is often intentionally relative (e.g. /fastapi)
  // for browser traffic. Server-to-server fetches require an absolute origin.
  return absoluteHttpBase(process.env.BACKEND_URL)
    || absoluteHttpBase(process.env.NEXT_PUBLIC_BACKEND_URL)
    || DEFAULT_BACKEND_URL;
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

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
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
      url.searchParams.set("limit", String(boundedInteger(request.nextUrl.searchParams.get("limit"), 100, 1, 500)));
      url.searchParams.set("offset", String(boundedInteger(request.nextUrl.searchParams.get("offset"), 0, 0, 100_000)));
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
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json(
      { detail: timeout ? "Social backend timeout" : "Social backend unavailable" },
      { status: 503 },
    );
  }
}
