import { NextRequest, NextResponse } from "next/server";

// data-tag: api.token_holders
// Returns top holders via Helius RPC with Pump.fun fallback for bonding curve tokens

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HELIUS_URL =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;
const SOLSCAN_BASE = "https://api.solscan.io";

interface Holder {
  address: string;     // owner wallet
  tokenAccount: string;
  amount: number;      // human-readable
  pct: number;         // % of supply
}

interface PumpHolder {
  address: string;
  balance: string;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(HELIUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.result as T;
}

// Fetch holders from GMGN API (free, instant, works for bonding curve)
async function fetchGmgnHolders(mint: string): Promise<{ holders: Holder[]; totalSupply: number } | null> {
  try {
    // Try alternative endpoint format
    const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/solana/${mint}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://gmgn.ai/",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return null;
    }

    const raw = await res.json();

    // Different GMGN endpoint formats
    let data = raw.data || raw;
    if (!data || typeof data !== 'object') {
      return null;
    }


    // Try to find holder data in various formats
    const holderCount = data.holder_count || data.holders || data.holderCount || 0;
    const topHolders = data.top_holders || data.topHolders || data.holders_list || [];
    const supply = data.total_supply || data.totalSupply || data.supply || "1000000000";


    const totalSupply = parseFloat(supply);

    // If no top_holders but have holder_count, return empty list with total
    if (!topHolders || topHolders.length === 0) {
      return { holders: [], totalSupply: holderCount || totalSupply };
    }

    const holders: Holder[] = topHolders.slice(0, 20).map((h: any) => ({
      address: h.address || h.owner || h.wallet,
      tokenAccount: h.address || h.tokenAccount,
      amount: parseFloat(h.balance || h.amount || h.uiAmount || "0"),
      pct: h.percentage || h.pct || (parseFloat(h.balance || "0") / totalSupply) * 100,
    }));

    return { holders, totalSupply };
  } catch (e) {
    return null;
  }
}

// Fetch holders from Birdeye API (free tier available)
async function fetchBirdeyeHolders(mint: string): Promise<{ holders: Holder[]; totalSupply: number } | null> {
  const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
  if (!BIRDEYE_API_KEY) return null;

  try {
    const res = await fetch(`https://public-api.birdeye.so/public/token_holders?address=${mint}&offset=0&limit=20`, {
      headers: {
        Accept: "application/json",
        "X-API-KEY": BIRDEYE_API_KEY,
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return null;
    }

    const raw = await res.json();

    const data = raw.data || raw;
    if (!data?.items || data.items.length === 0) {
      return null;
    }

    const totalSupply = parseFloat(data.totalSupply || "1000000000");
    const holders: Holder[] = data.items.map((h: any) => ({
      address: h.owner || h.address,
      tokenAccount: h.address,
      amount: parseFloat(h.uiAmount || h.balance || "0"),
      pct: (parseFloat(h.uiAmount || h.balance || "0") / totalSupply) * 100,
    }));

    return { holders, totalSupply };
  } catch (e) {
    return null;
  }
}

// Fetch holders from Pump.fun API (for bonding curve tokens)
async function fetchPumpHolders(mint: string): Promise<{ holders: Holder[]; totalSupply: number } | null> {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}/holders?limit=20&offset=0`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) return null;

    const data = await res.json() as { holders?: PumpHolder[]; total_supply?: string };
    if (!data.holders || data.holders.length === 0) return null;

    const totalSupply = parseFloat(data.total_supply || "1000000000");

    const holders: Holder[] = data.holders.map((h) => ({
      address: h.address,
      tokenAccount: h.address,
      amount: parseFloat(h.balance),
      pct: (parseFloat(h.balance) / totalSupply) * 100,
    }));

    return { holders, totalSupply };
  } catch {
    return null;
  }
}

// Fetch holders from Solscan API (requires API key)
async function fetchSolscanHolders(mint: string): Promise<{ holders: Holder[]; totalSupply: number } | null> {
  if (!SOLSCAN_API_KEY) return null;

  try {
    // Get token holders
    const holdersRes = await fetch(
      `${SOLSCAN_BASE}/token/holders?tokenAddress=${mint}&limit=20`,
      {
        headers: {
          Accept: "application/json",
          Token: SOLSCAN_API_KEY,
        },
        cache: "no-store",
      }
    );

    if (!holdersRes.ok) return null;

    const holdersData = await holdersRes.json() as {
      data?: Array<{
        address: string;
        amount: string;
        decimals: number;
        owner: string;
      }>;
      total?: number;
    };

    if (!holdersData.data || holdersData.data.length === 0) return null;

    // Get token supply for percentage calculation
    const metaRes = await fetch(
      `${SOLSCAN_BASE}/token/meta?tokenAddress=${mint}`,
      {
        headers: {
          Accept: "application/json",
          Token: SOLSCAN_API_KEY,
        },
        cache: "no-store",
      }
    );

    let totalSupply = 1_000_000_000; // Default for Pump.fun
    if (metaRes.ok) {
      const meta = await metaRes.json() as { supply?: string; decimals?: number };
      if (meta.supply && meta.decimals !== undefined) {
        totalSupply = parseFloat(meta.supply) / Math.pow(10, meta.decimals);
      }
    }

    const holders: Holder[] = holdersData.data.map((h) => ({
      address: h.owner || h.address,
      tokenAccount: h.address,
      amount: parseFloat(h.amount) / Math.pow(10, h.decimals || 9),
      pct: (parseFloat(h.amount) / Math.pow(10, h.decimals || 9) / totalSupply) * 100,
    }));

    return { holders, totalSupply };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) return NextResponse.json({ error: "mint required" }, { status: 400 });


  // 1. Try GMGN first (free, instant, works for all tokens including bonding curve)
  const gmgnData = await fetchGmgnHolders(mint);
  if (gmgnData) {
    return NextResponse.json(gmgnData);
  }

  // 2. Try Pump.fun (bonding curve tokens)
  const pumpData = await fetchPumpHolders(mint);
  if (pumpData) {
    return NextResponse.json(pumpData);
  }

  // 3. Try Birdeye API
  const birdeyeData = await fetchBirdeyeHolders(mint);
  if (birdeyeData) {
    return NextResponse.json(birdeyeData);
  }

  // 4. Try Solscan API (requires API key)
  const solscanData = await fetchSolscanHolders(mint);
  if (solscanData) {
    return NextResponse.json(solscanData);
  }

  // 4. Try DexScreener (fast, no API key, but limited holder data)
  try {
    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      cache: "no-store",
    });
    if (dexRes.ok) {
      const dexData = await dexRes.json() as {
        pairs?: Array<{ holders?: number; liquidity?: { usd?: number } }>;
      };
      const pair = dexData.pairs?.[0];
      if (pair?.holders) {
        // DexScreener doesn't give top holders list, just count
        return {
          holders: [], // No list available
          totalSupply: pair.holders,
          note: "holder_count_only",
        } as any;
      }
    }
  } catch (e) {
  }

  // 5. Fallback to Helius RPC (migrated/DEX tokens)
  try {
    // 1) Largest token accounts (top 20)
    const largest = await rpc<{ value: { address: string; uiAmount: number }[] }>(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }]
    );

    if (!largest.value || largest.value.length === 0) {
      return NextResponse.json({ holders: [], totalSupply: 0 });
    }

    // 2) Total supply
    const supply = await rpc<{ value: { uiAmount: number } }>(
      "getTokenSupply",
      [mint]
    );
    const totalSupply = supply.value.uiAmount || 1;

    // 3) Fetch owners for each token account in parallel batches
    const accounts = largest.value.slice(0, 20);
    const owners = await Promise.all(
      accounts.map(async (acc) => {
        try {
          const info = await rpc<{ value: { data: { parsed?: { info?: { owner?: string } } } } | null }>(
            "getAccountInfo",
            [acc.address, { encoding: "jsonParsed", commitment: "confirmed" }]
          );
          return info.value?.data?.parsed?.info?.owner ?? acc.address;
        } catch {
          return acc.address;
        }
      })
    );

    const holders: Holder[] = accounts.map((acc, i) => ({
      address: owners[i],
      tokenAccount: acc.address,
      amount: acc.uiAmount,
      pct: (acc.uiAmount / totalSupply) * 100,
    }));

    return NextResponse.json({ holders, totalSupply });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch_failed";

    // Handle specific "could not find mint" error gracefully
    if (msg.includes("could not find mint") || msg.includes("Invalid param")) {
      return NextResponse.json({
        holders: [],
        totalSupply: 0,
        error: "Token not found on-chain. This may be a bonding curve token before migration.",
      });
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
