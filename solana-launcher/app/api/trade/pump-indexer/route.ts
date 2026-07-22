// data-tag: api.trade.pump-indexer
// Control endpoint for the PumpPortal WebSocket indexer.
//   GET    → status
//   POST   → start
//   DELETE → stop
import { NextRequest, NextResponse } from "next/server";
import { startIndexer, stopIndexer, getIndexerStats } from "@/lib/trade/pump-portal-indexer";
import { requireProdAuth } from "@/lib/routeAuth";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getIndexerStats());
}

export async function POST(_req: NextRequest) {
  const authError = await requireProdAuth(_req);
  if (authError) return authError;

  const stats = startIndexer();
  return NextResponse.json({ ok: true, stats });
}

export async function DELETE(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const stats = stopIndexer();
  return NextResponse.json({ ok: true, stats });
}
