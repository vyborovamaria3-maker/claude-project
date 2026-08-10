import { NextRequest, NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/authProxy";

const REQUIRE_AUTH = process.env.NODE_ENV === "production";
const SESSION_COOKIE = "potapoff_access_token";

function authorizationFor(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header;

  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
  return sessionToken ? `Bearer ${sessionToken}` : null;
}

export async function requireProdAuth(req: NextRequest) {
  if (!REQUIRE_AUTH) return null;

  const authHeader = authorizationFor(req);
  if (!authHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/v1/users/access`, {
      headers: { Authorization: authHeader },
      cache: "no-store",
    });

    if (response.status === 403) {
      return NextResponse.json({ error: "Active subscription required" }, { status: 403 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  }

  return null;
}
