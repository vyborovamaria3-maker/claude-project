// data-tag: api.trade.token_info
// Aggregates pump.fun + dexscreener metadata: name, symbol, image, socials, holders, volume.
import { NextRequest, NextResponse } from "next/server";
import { getCache, setCache } from "@/lib/trade/db";
import { appendHeliusApiKey, getHeliusApiKeys, isHeliusRetryableStatus } from "@/lib/trade/helius-rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUMP_API = "https://swap-api.pump.fun/v1";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;
const SOLSCAN_BASE = "https://api.solscan.io";
const HELIUS_KEYS = getHeliusApiKeys();

async function fetchHeliusRpc<T>(body: unknown): Promise<T | null> {
  const keys = HELIUS_KEYS.length > 0 ? HELIUS_KEYS : [""];
  for (let index = 0; index < keys.length; index += 1) {
    const apiKey = keys[index] ?? "";
    const url = appendHeliusApiKey("https://mainnet.helius-rpc.com/", apiKey);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return (await response.json()) as T;
    }
    if (!isHeliusRetryableStatus(response.status) || index === keys.length - 1) {
      return null;
    }
  }
  return null;
}

/** Normalize social URL - ensure https:// prefix */
function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // Handle common patterns
  if (url.startsWith("twitter.com/") || url.startsWith("x.com/")) return `https://${url}`;
  if (url.startsWith("t.me/")) return `https://${url}`;
  if (url.startsWith("discord.gg/") || url.startsWith("discord.com/")) return `https://${url}`;
  if (url.includes(".") && !url.includes(" ")) return `https://${url}`;
  return null;
}

interface TokenInfo {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  image?: string | null;
  creator?: string | null;
  createdAt?: number | null;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  volumeTotalSol?: number | null;
  holders?: number | null;
  totalSupply?: number | null;
  isPumpFun: boolean;
  isMigrated: boolean;
  socials: {
    twitter?: string | null;
    telegram?: string | null;
    website?: string | null;
    discord?: string | null;
  };
  fetchedAt: number;
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  if (!mint || !MINT_RE.test(mint)) {
    return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  }

  // Cache hit (v2 key вЂ” bumped when image enrichment was added)
  const cached = getCache<TokenInfo>("analysis_cache" /* reuse */, `info-v2:${mint}`);
  if (cached) return NextResponse.json(cached);

  const info: TokenInfo = {
    mint,
    isPumpFun: false,
    isMigrated: false,
    socials: {},
    fetchedAt: Date.now(),
  };

  // в”Ђв”Ђ 1. Pump.fun metadata в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  try {
    const r = await fetch(`${PUMP_API}/coins/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (r.ok) {
      const data = (await r.json()) as Record<string, unknown>;
      info.isPumpFun = true;
      info.name = (data.name as string) ?? null;
      info.symbol = (data.symbol as string) ?? null;
      info.description = (data.description as string) ?? null;
      info.image =
        (data.image as string) ??
        (data.imageUri as string) ??
        (data.image_uri as string) ??
        (data.imageUrl as string) ??
        (data.metadataUri as string) ??
        null;
      info.creator =
        (data.creator as string) ??
        (data.creatorAddress as string) ??
        (data.creator_address as string) ??
        (data.deployer as string) ??
        null;
      const createdMs =
        (data.createdAt as number) ??
        (data.created_timestamp as number) ??
        (data.timestamp as number) ??
        null;
      info.createdAt = typeof createdMs === "number" ? (createdMs > 1e12 ? createdMs : createdMs * 1000) : null;
      info.marketCapUsd =
        (data.usdMarketCap as number) ??
        (data.usd_market_cap as number) ??
        (data.marketCap as number) ??
        null;
      info.totalSupply = (data.totalSupply as number) ?? (data.total_supply as number) ?? 1_000_000_000;
      info.isMigrated = Boolean(data.complete ?? data.completed ?? data.migrated);
      info.socials.twitter = normalizeUrl((data.twitter as string) ?? null);
      info.socials.telegram = normalizeUrl((data.telegram as string) ?? null);
      info.socials.website = normalizeUrl((data.website as string) ?? null);
      info.socials.discord = normalizeUrl((data.discord as string) ?? null);
    }
  } catch (e) {
  }

  // в”Ђв”Ђ 2. DexScreener (volume, liquidity, holders, price) в”Ђв”Ђв”Ђв”Ђв”Ђ
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      cache: "no-store",
    });
    if (r.ok) {
      const json = (await r.json()) as {
        pairs?: Array<{
          priceUsd?: string;
          liquidity?: { usd?: number };
          volume?: { h24?: number };
          fdv?: number;
          marketCap?: number;
          info?: {
            imageUrl?: string;
            header?: string;
            socials?: Array<{ type: string; url: string }>;
            websites?: Array<{ url: string }>;
          };
          baseToken?: { name?: string; symbol?: string };
        }>;
      };
      // pick the most liquid pair
      const pair = json.pairs?.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (pair) {
        info.priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
        info.liquidityUsd = pair.liquidity?.usd ?? null;
        info.volume24hUsd = pair.volume?.h24 ?? null;
        info.marketCapUsd = info.marketCapUsd ?? pair.marketCap ?? pair.fdv ?? null;
        if (!info.name) info.name = pair.baseToken?.name ?? null;
        if (!info.symbol) info.symbol = pair.baseToken?.symbol ?? null;
        if (!info.image && pair.info?.imageUrl) info.image = pair.info.imageUrl;

        // Socials from dexscreener (normalize URLs)
        for (const s of pair.info?.socials ?? []) {
          if (s.type === "twitter" && !info.socials.twitter) info.socials.twitter = normalizeUrl(s.url);
          if (s.type === "telegram" && !info.socials.telegram) info.socials.telegram = normalizeUrl(s.url);
          if (s.type === "discord" && !info.socials.discord) info.socials.discord = normalizeUrl(s.url);
        }
        if (!info.socials.website && pair.info?.websites?.[0]?.url) info.socials.website = normalizeUrl(pair.info.websites[0].url);
      }
    }
  } catch (e) {
  }

  // в”Ђв”Ђ 3. Holder count: try Helius first, fallback to Pump.fun for bonding curve в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  let holdersFromHelius: number | null = null;

  if (HELIUS_KEYS.length > 0) {
    try {
      const json = await fetchHeliusRpc<{ result?: { total?: number; token_accounts?: unknown[] } }>({
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenAccounts",
        params: { mint, limit: 1000 },
      });
      holdersFromHelius = json?.result?.total ?? json?.result?.token_accounts?.length ?? null;
    } catch {
    }
  }

  // Fallback 1: GMGN (free, instant, works for all tokens)
  if (!holdersFromHelius) {
    try {
      const gmgnRes = await fetch(`https://gmgn.ai/api/v1/tokens/solana/${mint}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        cache: "no-store",
      });
      if (gmgnRes.ok) {
        const gmgnData = await gmgnRes.json() as { data?: { holder_count?: number } };
        if (gmgnData.data?.holder_count) {
          info.holders = gmgnData.data.holder_count;
        }
      }
    } catch (e) {
    }
  }

  // Fallback 2: Pump.fun holder count for bonding curve tokens
  if (!info.holders && !holdersFromHelius && info.isPumpFun) {
    try {
      const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${mint}/holders?limit=1&offset=0`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (pumpRes.ok) {
        const pumpData = await pumpRes.json() as { total_holders?: number };
        if (pumpData.total_holders) {
          info.holders = pumpData.total_holders;
        }
      }
    } catch (e) {
    }
  }

  // Fallback 2: Solscan API (requires API key)
  if (!info.holders && SOLSCAN_API_KEY) {
    try {
      const solscanRes = await fetch(
        `${SOLSCAN_BASE}/token/holders?tokenAddress=${mint}&limit=1`,
        {
          headers: {
            Accept: "application/json",
            Token: SOLSCAN_API_KEY,
          },
          cache: "no-store",
        }
      );
      if (solscanRes.ok) {
        const solscanData = await solscanRes.json() as { total?: number };
        if (solscanData.total) {
          info.holders = solscanData.total;
        }
      }
    } catch (e) {
    }
  }

  // If Helius worked, use that
  if (!info.holders && holdersFromHelius) {
    info.holders = holdersFromHelius;
  }

  // в”Ђв”Ђ 4. Image fallback via Helius DAS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  if (HELIUS_KEYS.length > 0 && !info.image) {

    try {
      const json = await fetchHeliusRpc<{
        result?: {
          content?: {
            files?: Array<{ uri?: string; cdn_uri?: string; mime?: string }>;
            links?: { image?: string };
            json_uri?: string;
            metadata?: { name?: string; symbol?: string; description?: string };
          };
        };
      }>({
        jsonrpc: "2.0",
        id: "asset",
        method: "getAsset",
        params: { id: mint },
      });
      const c = json?.result?.content;
      info.image =
        c?.files?.find((f) => f.mime?.startsWith("image/"))?.cdn_uri ??
        c?.files?.[0]?.cdn_uri ??
        c?.files?.[0]?.uri ??
        c?.links?.image ??
        null;
      if (!info.name && c?.metadata?.name) info.name = c.metadata.name;
      if (!info.symbol && c?.metadata?.symbol) info.symbol = c.metadata.symbol;
      if (!info.description && c?.metadata?.description) info.description = c.metadata.description;
    } catch (e) {
    }
  }

  // в”Ђв”Ђ 4. Last resort: fetch off-chain metadata JSON if image is a metadata URI в”Ђв”Ђ
  if (info.image && /\.json($|\?)|\/metadata/i.test(info.image)) {
    try {
      const url = info.image.startsWith("ipfs://")
        ? `https://ipfs.io/ipfs/${info.image.slice(7)}`
        : info.image;
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new Error("Blocked non-https metadata URL");
      }

      const r = await fetch(parsed.toString(), {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const contentType = r.headers.get("content-type") || "";
      if (r.ok && contentType.includes("application/json")) {
        const meta = (await r.json()) as { image?: string; image_uri?: string };
        info.image = meta.image ?? meta.image_uri ?? info.image;
      }
    } catch {
      // keep original
    }
  }

  setCache("analysis_cache", `info-v2:${mint}`, info, 30 * 60_000); // 30min
  return NextResponse.json(info);
}
