import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_traders
// Top traders by volume/PnL via Bitquery GraphQL EAP (Solana DEX trades)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BITQUERY_KEY = process.env.BITQUERY_API_KEY || "";
const BITQUERY_URL = "https://streaming.bitquery.io/eap";

interface TraderRow {
  address: string;
  boughtUsd: number;
  soldUsd: number;
  pnlUsd: number;
  txCount: number;
  lastTradeTs: number;
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });
  if (!BITQUERY_KEY) {
    return NextResponse.json({ error: "BITQUERY_API_KEY missing", traders: [] }, { status: 503 });
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const query = `
    query TopTraders($mint: String!) {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: { Currency: { MintAddress: { is: $mint } } }
            Block: { Time: { since: "${since}" } }
          }
          limit: { count: 30 }
          orderBy: { descendingByField: "volumeUsd" }
        ) {
          Trade {
            Account { Owner }
          }
          volumeUsd: sum(of: Trade_Side_AmountInUSD)
          buyUsd: sum(of: Trade_Side_AmountInUSD, if: { Trade: { Side: { Type: { is: buy } } } })
          sellUsd: sum(of: Trade_Side_AmountInUSD, if: { Trade: { Side: { Type: { is: sell } } } })
          txCount: count
        }
      }
    }
  `;

  try {
    const r = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_KEY,
      },
      body: JSON.stringify({ query, variables: { mint } }),
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json({ error: `bitquery_${r.status}`, traders: [] }, { status: 502 });
    }
    const data = await r.json();
    if (data.errors) {
      return NextResponse.json({ error: data.errors[0]?.message ?? "bitquery_error", traders: [] }, { status: 502 });
    }

    const rows = data.data?.Solana?.DEXTradeByTokens ?? [];
    const traders: TraderRow[] = rows.map((row: {
      Trade: { Account: { Owner: string } };
      buyUsd: number;
      sellUsd: number;
      txCount: number;
    }) => {
      const bought = Number(row.buyUsd) || 0;
      const sold = Number(row.sellUsd) || 0;
      return {
        address: row.Trade?.Account?.Owner ?? "",
        boughtUsd: bought,
        soldUsd: sold,
        pnlUsd: sold - bought,
        txCount: Number(row.txCount) || 0,
        lastTradeTs: 0,
      };
    });

    return NextResponse.json({ traders });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch_failed";
    return NextResponse.json({ error: msg, traders: [] }, { status: 500 });
  }
}
