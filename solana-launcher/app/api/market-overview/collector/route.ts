import { NextResponse } from "next/server";
import { getMarketCollectorStatus } from "@/lib/trade/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The collector is a separate process; a Next.js route cannot inspect its
// in-memory WebSocket state. Return actual persisted counts instead of zeros.
export async function GET() {
  try {
    const db = getMarketCollectorStatus();
    return NextResponse.json({
      isRunning: null,
      wsConnected: null,
      statusSource: "sqlite",
      eventsSinceStart: null,
      events: db.events,
      lastEventAt: db.lastEventAt,
      launches: db.launches,
      migrations: db.migrations,
      trades: db.trades,
    });
  } catch {
    return NextResponse.json(
      { error: "market collector database status unavailable" },
      { status: 503 },
    );
  }
}
