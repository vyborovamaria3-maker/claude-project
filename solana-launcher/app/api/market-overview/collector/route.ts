import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    isRunning: false,
    wsConnected: false,
    eventsSinceStart: 0,
    events: 0,
    lastEventAt: null,
    launches: 0,
    migrations: 0,
    trades: 0,
  });
}
