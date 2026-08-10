import { NextRequest, NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/authProxy";

const REQUIRE_AUTH = process.env.NODE_ENV === "production";
const AUTH_TIMEOUT_MS = 5_000;

type AuthenticatedUser = {
  is_superuser?: boolean;
};

async function resolveProdUser(req: NextRequest): Promise<AuthenticatedUser | NextResponse | null> {
  if (!REQUIRE_AUTH) return null;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/v1/auth/me`, {
      headers: { Authorization: authHeader },
      cache: "no-store",
      signal: controller.signal,
    });

    if (response.status === 401) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (response.status === 403) {
      return NextResponse.json({ error: "Active subscription required" }, { status: 403 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
    }

    return (await response.json()) as AuthenticatedUser;
  } catch {
    return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

export async function requireProdAuth(req: NextRequest) {
  const result = await resolveProdUser(req);
  return result instanceof NextResponse ? result : null;
}

export async function requireProdSuperuser(req: NextRequest) {
  const result = await resolveProdUser(req);
  if (result instanceof NextResponse) return result;
  if (!REQUIRE_AUTH) return null;
  if (!result?.is_superuser) {
    return NextResponse.json({ error: "Administrator access required" }, { status: 403 });
  }
  return null;
}
