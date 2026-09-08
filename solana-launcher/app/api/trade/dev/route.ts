// data-tag: api.trade.dev
// GET /api/trade/dev?mint=...   → resolve creator + run full dev analysis
// GET /api/trade/dev?creator=... → run dev analysis directly
import { NextRequest, NextResponse } from "next/server";
import { analyzeDev, getCreatorForMint } from "@/lib/trade/dev";
import { getDevTag, getDevTokensByCreator, getDevWallet } from "@/lib/trade/db";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function buildCachedDevResponse(creator: string, warning: string | null) {
  const cachedTokens = getDevTokensByCreator(creator, 5000);
  const cachedWallet = getDevWallet(creator);
  if (cachedTokens.length === 0 && !cachedWallet) return null;

  const tag = getDevTag(creator);
  const totalTokensCreated = cachedWallet?.totalTokens ?? cachedTokens.length;
  const migratedCount = cachedWallet?.migratedCount ?? cachedTokens.filter((token) => token.isMigrated).length;
  const reached300kCount = cachedWallet?.reached300kCount ?? cachedTokens.filter((token) => token.reached300k).length;
  const migrationRate = cachedWallet?.migrationRate ?? (totalTokensCreated > 0 ? migratedCount / totalTokensCreated : 0);
  const rate300k = cachedWallet?.rate300k ?? (totalTokensCreated > 0 ? reached300kCount / totalTokensCreated : 0);
  const tokens = cachedTokens.map((token) => ({
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    createdAt: token.createdAt,
    marketCapUsd: token.marketCapUsd,
    athUsd: token.athUsd,
    isMigrated: token.isMigrated,
    reached300k: token.reached300k,
  }));

  return {
    address: creator,
    tokens,
    totalTokensCreated,
    totalTokens: totalTokensCreated,
    migratedCount,
    migrationRate,
    reached300kCount,
    rate300k,
    bestLaunchHourUtc: cachedWallet?.bestLaunchHour ?? null,
    launchesByHour: Array.from({ length: 24 }, () => 0),
    userTag: tag?.tag ?? null,
    userNote: tag?.note ?? null,
    degraded: true,
    warning,
    avgMcUsd: cachedWallet?.avgMcUsd ?? null,
    maxMcUsd: cachedWallet?.maxMcUsd ?? null,
    riskScore: undefined,
    riskLevel: undefined,
    riskReasons: undefined,
  };
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  let creator = req.nextUrl.searchParams.get("creator")?.trim() || null;
  const skipCache = req.nextUrl.searchParams.get("refresh") === "1";

  if (!mint && !creator) {
    return NextResponse.json({ error: "mint or creator required" }, { status: 400 });
  }
  if (mint && !ADDR_RE.test(mint)) {
    return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  }
  if (creator && !ADDR_RE.test(creator)) {
    return NextResponse.json({ error: "invalid creator" }, { status: 400 });
  }

  if (!creator && mint) {
    creator = await getCreatorForMint(mint);
    if (!creator) return NextResponse.json({ creator: null, analysis: null });
  }

  if (!skipCache) {
    const cached = buildCachedDevResponse(creator!, "Показаны сохранённые данные DEV кошелька. Используйте refresh=1 для live обновления.");
    if (cached) return NextResponse.json(cached);
  }

  try {
    const analysis = await analyzeDev(creator!, { skipCache });
    const tag = getDevTag(analysis.address);
    return NextResponse.json({ ...analysis, userTag: tag?.tag ?? null, userNote: tag?.note ?? null });
  } catch (e) {
    const message = (e as Error).message;
    const cached = buildCachedDevResponse(
      creator!,
      message.includes("HTTP 429") || message.toLowerCase().includes("rate limited")
        ? "External Pump.fun API is rate limited. Showing cached local dev analysis."
        : `Live dev analysis failed (${message}). Showing cached local dev analysis.`
    );
    if (cached) return NextResponse.json(cached);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
