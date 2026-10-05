import type { NextRequest } from "next/server";

const DEFAULT_TIMEOUT_MS = 15_000;

function absoluteBase(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return candidate.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function backendBaseCandidates(): string[] {
  return Array.from(new Set([
    absoluteBase(process.env.BACKEND_URL),
    absoluteBase(process.env.NEXT_PUBLIC_BACKEND_URL),
    "http://backend:8000",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
  ].filter((value): value is string => Boolean(value))));
}

export function forwardedSubscriberHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  const backendApiKey = process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || "";
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  if (backendApiKey) headers["X-Backend-API-Key"] = backendApiKey;
  return headers;
}

export async function fetchBackendSocial(
  request: NextRequest,
  backendPath: string,
  searchParams?: URLSearchParams,
): Promise<Response> {
  let lastError: unknown = null;

  for (const baseUrl of backendBaseCandidates()) {
    const url = new URL(`${baseUrl}${backendPath}`);
    if (searchParams) {
      for (const [key, value] of searchParams) url.searchParams.append(key, value);
    }
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: forwardedSubscriberHeaders(request),
        cache: "no-store",
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  console.error(`[social-proxy] backend unavailable for ${backendPath}`, lastError);
  return Response.json(
    { detail: "Social intelligence backend unavailable" },
    { status: 503 },
  );
}

export async function passthroughJson(response: Response): Promise<Response> {
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
