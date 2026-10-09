import { NextResponse } from "next/server";
import { getChainAnalysisCached } from "@/lib/trade/chain/service";

export const runtime = "nodejs";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Math.max(1, Number(process.env.CHAIN_FULL_RATE_LIMIT_PER_MIN || 12));

type RateEntry = { windowStart: number; count: number };
const rate = new Map<string, RateEntry>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function rateAllowed(key: string, now: number): boolean {
  const row = rate.get(key);
  if (!row || now - row.windowStart >= RATE_WINDOW_MS) {
    rate.set(key, { windowStart: now, count: 1 });
    return true;
  }
  row.count += 1;
  return row.count <= RATE_LIMIT;
}

function pruneRate(now: number) {
  for (const [key, value] of rate) if (now - value.windowStart >= RATE_WINDOW_MS * 2) rate.delete(key);
}

export async function POST(request: Request) {
  const started = Date.now();
  pruneRate(started);
  if (!rateAllowed(clientKey(request), started)) {
    return NextResponse.json(
      { error: "chain-full rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: { mint?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const mint = String(body?.mint ?? "").trim();
  if (!MINT_RE.test(mint)) return NextResponse.json({ error: "invalid mint" }, { status: 400 });

  try {
    const result = await getChainAnalysisCached(mint);
    return NextResponse.json({ ...result.value, cacheHit: result.cacheHit, cacheSource: result.cacheSource, cacheAgeMs: result.ageMs, latencyMs: Date.now() - started });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "chain-full failed" },
      { status: 502 },
    );
  }
}
