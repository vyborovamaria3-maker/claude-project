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
const MAX_METADATA_BYTES = 512 * 1024;
const ALLOWED_METADATA_HOSTS = new Set([
  "ipfs.io",
  "cf-ipfs.com",
  "gateway.pinata.cloud",
  "arweave.net",
  "nftstorage.link",
  "shdw-drive.genesysgo.net",
]);

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
    if (response.ok) return (await response.json()) as T;
    if (!isHeliusRetryableStatus(response.status) || index === keys.length - 1) return null;
  }
  return null;
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("twitter.com/") || url.startsWith("x.com/")) return `https://${url}`;
  if (url.startsWith("t.me/")) return `https://${url}`;
  if (url.startsWith("discord.gg/") || url.startsWith("discord.com/")) return `https://${url}`;
  if (url.includes(".") && !url.includes(" ")) return `https://${url}`;
  return null;
}

function isAllowedMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    ALLOWED_METADATA_HOSTS.has(host) ||
    host.endsWith(".mypinata.cloud") ||
    host.endsWith(".nftstorage.link") ||
    host.endsWith(".arweave.net")
  );
}

function resolveMetadataUrl(value: string): URL {
  const rewritten = value.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${value.slice(7)}`
    : value;
  const parsed = new URL(rewritten);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Blocked metadata URL");
  }
  if (!isAllowedMetadataHost(parsed.hostname)) {
    throw new Error("Metadata host is not allowlisted");
  }
  return parsed;
}

async function readJsonWithLimit(response: Response): Promise<{ image?: string; image_uri?: string }> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_METADATA_BYTES) {
    throw new Error("Metadata response is too large");
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_METADATA_BYTES) {
      await reader.cancel();
      throw new Error("Metadata response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as { image?: string; image_uri?: string };
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

  const cached = getCache<TokenInfo>("analysis_cache", `info-v2:${mint}`);
  if (cached) return NextResponse.json(cached);

  const info: TokenInfo = {
    mint,
    isPumpFun: false,
    isMigrated: false,
    socials: {},
    fetchedAt: Date.now(),
  };

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
  } catch {
    // Pump.fun is an optional enrichment source.
  }

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { cache: "no-store" });
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
      const pair = json.pairs?.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (pair) {
        info.priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
        info.liquidityUsd = pair.liquidity?.usd ?? null;
        info.volume24hUsd = pair.volume?.h24 ?? null;
        info.marketCapUsd = info.marketCapUsd ?? pair.marketCap ?? pair.fdv ?? null;
        if (!info.name) info.name = pair.baseToken?.name ?? null;
        if (!info.symbol) info.symbol = pair.baseToken?.symbol ?? null;
        if (!info.image && pair.info?.imageUrl) info.image = pair.info.imageUrl;
        for (const s of pair.info?.socials ?? []) {
          if (s.type === "twitter" && !info.socials.twitter) info.socials.twitter = normalizeUrl(s.url);
          if (s.type === "telegram" && !info.socials.telegram) info.socials.telegram = normalizeUrl(s.url);
          if (s.type === "discord" && !info.socials.discord) info.socials.discord = normalizeUrl(s.url);
        }
        if (!info.socials.website && pair.info?.websites?.[0]?.url) {
          info.socials.website = normalizeUrl(pair.info.websites[0].url);
        }
      }
    }
  } catch {
    // DexScreener is optional enrichment.
  }

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
      // fall through
    }
  }

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
        const gmgnData = (await gmgnRes.json()) as { data?: { holder_count?: number } };
        if (gmgnData.data?.holder_count) info.holders = gmgnData.data.holder_count;
      }
    } catch {
      // fall through
    }
  }

  if (!info.holders && !holdersFromHelius && info.isPumpFun) {
    try {
      const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${mint}/holders?limit=1&offset=0`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (pumpRes.ok) {
        const pumpData = (await pumpRes.json()) as { total_holders?: number };
        if (pumpData.total_holders) info.holders = pumpData.total_holders;
      }
    } catch {
      // fall through
    }
  }

  if (!info.holders && SOLSCAN_API_KEY) {
    try {
      const solscanRes = await fetch(`${SOLSCAN_BASE}/token/holders?tokenAddress=${mint}&limit=1`, {
        headers: { Accept: "application/json", Token: SOLSCAN_API_KEY },
        cache: "no-store",
      });
      if (solscanRes.ok) {
        const solscanData = (await solscanRes.json()) as { total?: number };
        if (solscanData.total) info.holders = solscanData.total;
      }
    } catch {
      // fall through
    }
  }

  if (!info.holders && holdersFromHelius) info.holders = holdersFromHelius;

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
    } catch {
      // Helius DAS image enrichment is optional.
    }
  }

  if (info.image && (/\.json($|\?)/i.test(info.image) || /\/metadata/i.test(info.image))) {
    try {
      const url = resolveMetadataUrl(info.image);
      const r = await fetch(url, {
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });
      const contentType = r.headers.get("content-type") || "";
      if (r.ok && contentType.toLowerCase().includes("application/json")) {
        const meta = await readJsonWithLimit(r);
        info.image = meta.image ?? meta.image_uri ?? info.image;
      }
    } catch {
      // Keep the original metadata/image URI when enrichment is unsafe or unavailable.
    }
  }

  setCache("analysis_cache", `info-v2:${mint}`, info, 30 * 60_000);
  return NextResponse.json(info);
}
