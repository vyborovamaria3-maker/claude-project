import { NextRequest, NextResponse } from "next/server";
import { getMarketOverview } from "@/lib/marketOverview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MarketOverviewTimeframe = "1h" | "6h" | "24h" | "7d" | "30d" | "90d" | "180d" | "365d" | "all";

function parseTimeframe(raw: string | null): MarketOverviewTimeframe {
  const allowed: MarketOverviewTimeframe[] = ["1h", "6h", "24h", "7d", "30d", "90d", "180d", "365d", "all"];
  return (allowed.includes(raw as MarketOverviewTimeframe) ? raw : "30d") as MarketOverviewTimeframe;
}

export async function GET(request: NextRequest) {
  const timeframe = parseTimeframe(request.nextUrl.searchParams.get("timeframe"));
  const data = await getMarketOverview(timeframe);

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, max-age=30",
    },
  });
}
