import { NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/authProxy";

type AuthSuccess = { ownerId: string; error?: never };
type AuthFailure = { ownerId?: never; error: NextResponse };

/**
 * Fail-closed authorization for every TGInvite API route, including development.
 * Never accept an owner id from the browser. The identity comes from the backend JWT.
 */
export async function requireTGInviteUser(request: Request): Promise<AuthSuccess | AuthFailure> {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.method !== "GET") {
    if (fetchSite === "cross-site" || (origin && origin !== new URL(request.url).origin)) {
      return { error: NextResponse.json({ error: "Forbidden origin" }, { status: 403 }) };
    }
  }

  const bearer = request.headers.get("authorization");
  const rawCookie = request.headers.get("cookie") || "";
  const sessionCookie = rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("potapoff_access_token="));
  let cookieToken: string | undefined;
  if (sessionCookie) {
    try {
      cookieToken = decodeURIComponent(sessionCookie.slice("potapoff_access_token=".length));
    } catch {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
  }
  const authorization = bearer?.startsWith("Bearer ")
    ? bearer
    : cookieToken
      ? `Bearer ${cookieToken}`
      : null;
  if (!authorization) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  try {
    const headers = { Authorization: authorization };
    const access = await fetch(`${getBackendBaseUrl()}/api/v1/users/access`, {
      headers,
      cache: "no-store",
    });
    if (access.status === 403) {
      return { error: NextResponse.json({ error: "Active subscription required" }, { status: 403 }) };
    }
    if (!access.ok) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    const identity = await fetch(`${getBackendBaseUrl()}/api/v1/users/me`, {
      headers,
      cache: "no-store",
    });
    if (!identity.ok) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    const user = (await identity.json()) as { id?: unknown };
    if (typeof user.id !== "string" || !/^[0-9a-f-]{36}$/i.test(user.id)) {
      return { error: NextResponse.json({ error: "Invalid identity" }, { status: 401 }) };
    }
    return { ownerId: user.id };
  } catch {
    return { error: NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 }) };
  }
}
