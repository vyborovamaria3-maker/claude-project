import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(/\/$/, "");
const BACKEND_KEY = process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || "";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;
  if (!BACKEND_KEY) {
    return NextResponse.json({ error: "Backend key is not configured" }, { status: 503 });
  }
  try {
    const response = await fetch(
      `${BACKEND_BASE}/api/v1/kols/internal/related/${encodeURIComponent(handle)}`,
      {
        headers: { "X-Backend-API-Key": BACKEND_KEY },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Related-wallet lookup unavailable" },
      { status: 502 },
    );
  }
}
