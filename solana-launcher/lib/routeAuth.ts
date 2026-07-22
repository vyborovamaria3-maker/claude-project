import { NextRequest, NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/authProxy";

const REQUIRE_AUTH = process.env.NODE_ENV === "production";

export async function requireProdAuth(req: NextRequest) {
  if (!REQUIRE_AUTH) return null;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/v1/auth/me`, {
      headers: { Authorization: authHeader },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  }

  return null;
}
