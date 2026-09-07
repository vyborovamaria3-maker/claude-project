import { NextRequest, NextResponse } from "next/server";
import { requireProdAuth } from "@/lib/routeAuth";

// data-tag: api.token_bundles
// Sniper/JITO bundle detection via Bitquery — finds trades occurring in the same slot

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BITQUERY_KEY = process.env.BITQUERY_API_KEY || "";
const BITQUERY_URL = "https://streaming.bitquery.io/eap";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!SOLANA_ADDRESS_RE.test(mint)) {
    return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  }
  if (!BITQUERY_KEY) {
    return NextResponse.json({ error: "BITQUERY_API_KEY missing", bundles: [] }, { status: 503 });
  }

  // Find slots with multiple trades for same token (likely bundles)
  const query = `
    query Bundles($mint: String!) {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Currency: { MintAddress: { is: $mint } } }
            Block: { Time: { since: "${new Date(Date.now() - 24 * 3600 * 1000).toISOString()}" } }
          }
          limit: { count: 200 }
          orderBy: { ascendingByField: "Block_Slot" }
        ) {
          Block { Slot Time }
          Trade {
            Account { Owner }
            Side { Type AmountInUSD }
          }
        }
      }
    }
  `;

  try {
    const r = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": BITQUERY_KEY },
      body: JSON.stringify({ query, variables: { mint } }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return NextResponse.json({ error: `bitquery_${r.status}`, bundles: [] }, { status: 502 });
    const data = await r.json();
    if (data.errors) return NextResponse.json({ error: "bitquery_error", bundles: [] }, { status: 502 });

    type Row = {
      Block: { Slot: number; Time: string };
      Trade: { Account: { Owner: string }; Side: { Type: string; AmountInUSD: number } };
    };
    const trades: Row[] = data.data?.Solana?.DEXTradeByTokens ?? [];

    // Group by slot — bundles = slots with >=2 distinct owners trading
    const bySlot = new Map<number, { slot: number; time: string; wallets: Set<string>; usd: number; count: number }>();
    for (const t of trades) {
      const slot = t.Block.Slot;
      const owner = t.Trade?.Account?.Owner ?? "";
      const usd = Number(t.Trade?.Side?.AmountInUSD) || 0;
      const entry = bySlot.get(slot);
      if (entry) {
        entry.wallets.add(owner);
        entry.usd += usd;
        entry.count += 1;
      } else {
        bySlot.set(slot, { slot, time: t.Block.Time, wallets: new Set([owner]), usd, count: 1 });
      }
    }

    const bundles = Array.from(bySlot.values())
      .filter((b) => b.wallets.size >= 2)
      .map((b) => ({
        slot: b.slot,
        time: b.time,
        wallets: Array.from(b.wallets),
        totalUsd: b.usd,
        trades: b.count,
      }))
      .sort((a, b) => b.slot - a.slot)
      .slice(0, 50);

    return NextResponse.json(
      { bundles },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch {
    return NextResponse.json({ error: "bitquery_unavailable", bundles: [] }, { status: 502 });
  }
}
