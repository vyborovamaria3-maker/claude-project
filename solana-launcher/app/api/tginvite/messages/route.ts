import { NextResponse } from "next/server";
import { getBackendBaseUrl } from "@/lib/authProxy";
import { requireTGInviteUser } from "@/lib/tginvite-auth";

const PUBLIC_NAME = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/;

export async function POST(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;

  const serviceKey = process.env.TG_INVITE_INTERNAL_KEY;
  if (!serviceKey || serviceKey.length < 32) {
    return NextResponse.json({ error: "TGInvite history service not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const payload = body as { username?: unknown; limit?: unknown };
  if (typeof payload.username !== "string" || !PUBLIC_NAME.test(payload.username)) {
    return NextResponse.json({ error: "Public Telegram username required" }, { status: 422 });
  }
  const limit = payload.limit ?? 100;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
    return NextResponse.json({ error: "Limit must be between 1 and 200" }, { status: 422 });
  }

  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/v1/tginvite/messages`, {
      method: "POST",
      headers: {
        Authorization: user.authorization!,
        "X-TGInvite-Service-Key": serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: payload.username, limit }),
      cache: "no-store",
    });
    const data = await response.json() as Record<string, unknown>;
    return NextResponse.json(
      response.ok ? data : { error: data.detail ?? "Telegram history unavailable" },
      { status: response.status, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Telegram history service unavailable" }, { status: 503 });
  }
}
