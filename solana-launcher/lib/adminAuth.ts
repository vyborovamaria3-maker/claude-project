import { NextResponse } from "next/server";
import { getBackendBaseUrl } from "./authProxy";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** Keep the existing isolated localhost tools; remote and production access needs a real admin. */
export function isLocalAdminDevelopment(request: Request): boolean {
  return process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
}

export async function requireAdminAuth(request: Request): Promise<NextResponse | null> {
  const origin = request.headers.get("origin");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    (request.headers.get("sec-fetch-site") === "cross-site" || origin !== new URL(request.url).origin)) {
    return NextResponse.json({ error: "Same-origin request required" }, { status: 403, headers: noStore });
  }
  if (isLocalAdminDevelopment(request)) return null;

  const bearer = request.headers.get("authorization");
  let token: string | undefined;
  try {
    token = request.headers.get("cookie")?.split(";").map(part => part.trim())
      .find(part => part.startsWith("potapoff_access_token="))?.slice("potapoff_access_token=".length);
    if (token) token = decodeURIComponent(token);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  }
  const authorization = bearer?.startsWith("Bearer ") ? bearer : token ? `Bearer ${token}` : null;
  if (!authorization) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/v1/users/me`, {
      headers: { Authorization: authorization }, cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
    if (!response.ok) return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503, headers: noStore });
    const user = await response.json();
    if (user?.is_active !== true || user?.is_superuser !== true) {
      return NextResponse.json({ error: "Administrator access required" }, { status: 403, headers: noStore });
    }
    return null;
  } catch {
    return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503, headers: noStore });
  }
}
