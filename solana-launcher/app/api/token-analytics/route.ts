// data-tag: api.token_analytics
// Analyzes top 20 holders: P&L calculation, sybil detection, dev connections
import { NextRequest, NextResponse } from "next/server";
import { loadTokenTrades } from "@/lib/trade/trade-cache";
import type { RawTrade } from "@/lib/trade/helius";
import { persistTokenTrades } from "@/lib/trade/db";
import { appendHeliusApiKey, getHeliusApiKeys, isHeliusRetryableStatus } from "@/lib/trade/helius-rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;
const SOLSCAN_BASE = "https://api.solscan.io";
const HELIUS_API_KEYS = getHeliusApiKeys();

// Always use mainnet for analytics — devnet has no token data
function resolveRpc(): string {
  const raw = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "";
  const mainnetHelius = HELIUS_API_KEYS[0] ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEYS[0]}` : "";
  const fallback = mainnetHelius || "https://api.mainnet-beta.solana.com";
  if (!raw || raw.includes("devnet")) return fallback;
  return raw;
}
const HELIUS_RPC = resolveRpc();

interface Transaction {
  signature: string;
  timestamp: number;
  type: "buy" | "sell" | "transfer";
  wallet: string;
  tokenAmount: number;
  solAmount: number;
  price: number;
}

interface HolderAnalytics {
  address: string;
  tokenBalance: number;
  totalBought: number;
  totalSold: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  roi: number;
  txCount: number;
  firstBuyTime: number | null;
  lastActivity: number | null;
  isDev: boolean;
  connectedToDev: boolean;
  sybilGroup: number | null;
}

interface AnalyticsResponse {
  mint: string;
  devWallet: string | null;
  holders: HolderAnalytics[];
  sybilGroups: string[][];
  tokenPrice: number;
}

type RawHolder = { address: string; balance: number };

function normalizeHolders(holders: RawHolder[], limit = 20): RawHolder[] {
  const balances = new Map<string, number>();

  for (const holder of holders) {
    const address = holder.address?.trim();
    const balance = Number(holder.balance);

    if (!address || !Number.isFinite(balance) || balance <= 0) continue;
    balances.set(address, (balances.get(address) || 0) + balance);
  }

  return [...balances.entries()]
    .map(([address, balance]) => ({ address, balance }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

// Helius RPC helper
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });

  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.result as T;
}

// Get dev wallet from Pump.fun metadata
async function getDevWallet(mint: string): Promise<string | null> {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) return null;

    const data = await res.json() as { creator?: string; dev_wallet?: string };
    return data.dev_wallet || data.creator || null;
  } catch {
    return null;
  }
}

// Get holders from Birdeye API (free tier available)
async function getHoldersFromBirdeye(mint: string): Promise<{ address: string; balance: number }[]> {
  const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
  if (!BIRDEYE_API_KEY) {
    return [];
  }

  try {
    const res = await fetch(
      `https://public-api.birdeye.so/public/token_holders?address=${mint}&offset=0&limit=20`,
      {
        headers: {
          Accept: "application/json",
          "X-API-KEY": BIRDEYE_API_KEY,
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      return [];
    }

    const data = await res.json() as {
      data?: { items?: Array<{ owner?: string; address?: string; uiAmount?: number; balance?: string }> };
    };

    if (!data.data?.items || data.data.items.length === 0) {
      return [];
    }

    return normalizeHolders(data.data.items.map((h) => ({
      address: h.owner || h.address || "",
      balance: h.uiAmount || parseFloat(h.balance || "0"),
    })));
  } catch (e) {
    return [];
  }
}

async function getHoldersFromGmgn(mint: string): Promise<{ address: string; balance: number }[]> {
  try {
    const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/solana/${mint}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://gmgn.ai/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const raw = await res.json() as {
      data?: any;
      top_holders?: any[];
      topHolders?: any[];
      holders_list?: any[];
    };
    const data = raw.data || raw;
    const holders = data?.top_holders || data?.topHolders || data?.holders_list || [];

    if (!Array.isArray(holders) || holders.length === 0) return [];

    return normalizeHolders(holders.map((h: any) => ({
      address: h.address || h.owner || h.wallet || "",
      balance: parseFloat(String(h.balance || h.amount || h.uiAmount || "0")),
    })));
  } catch {
    return [];
  }
}

// Get holders from SolanaFM API
async function getHoldersFromSolanaFm(mint: string): Promise<{ address: string; balance: number }[]> {
  try {

    // First get token info for supply
    const supplyRes = await fetch(`https://api.solana.fm/v1/tokens/${mint}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!supplyRes.ok) {
      return [];
    }

    const supplyData = await supplyRes.json() as { result?: { tokenAccount?: { supply?: string; decimals?: number } } };
    const supply = supplyData.result?.tokenAccount?.supply;

    // Get largest accounts
    const largestRes = await fetch(`https://api.solana.fm/v1/tokens/${mint}/holders`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!largestRes.ok) {
      return [];
    }

    const data = await largestRes.json() as {
      result?: Array<{ address?: string; owner?: string; amount?: string; uiAmount?: number }>;
    };

    if (!data.result || data.result.length === 0) {
      return [];
    }

    return normalizeHolders(data.result.slice(0, 20).map((h) => ({
      address: h.owner || h.address || "",
      balance: h.uiAmount || parseFloat(h.amount || "0"),
    })));
  } catch (e) {
    return [];
  }
}

// Get holders from Pump.fun API
async function getHoldersFromPump(mint: string): Promise<{ address: string; balance: number }[]> {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}/holders?limit=20&offset=0`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return [];
    }

    const data = await res.json() as { holders?: Array<{ address: string; balance: string }> };

    if (!data.holders || data.holders.length === 0) {
      return [];
    }

    return normalizeHolders(data.holders.map((h) => ({
      address: h.address,
      balance: parseFloat(h.balance),
    })));
  } catch (e) {
    return [];
  }
}

async function getHoldersFromSolscan(mint: string): Promise<{ address: string; balance: number }[]> {
  if (!SOLSCAN_API_KEY) return [];

  try {
    const holdersRes = await fetch(`${SOLSCAN_BASE}/token/holders?tokenAddress=${mint}&limit=20`, {
      headers: {
        Accept: "application/json",
        Token: SOLSCAN_API_KEY,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!holdersRes.ok) return [];

    const data = await holdersRes.json() as {
      data?: Array<{
        address?: string;
        amount?: string;
        decimals?: number;
        owner?: string;
      }>;
    };

    if (!data.data || data.data.length === 0) return [];

    return normalizeHolders(data.data.map((h) => ({
      address: h.owner || h.address || "",
      balance: parseFloat(h.amount || "0") / Math.pow(10, h.decimals ?? 9),
    })));
  } catch {
    return [];
  }
}

// Get wallet creation time (first transaction timestamp)
async function getWalletCreationTime(address: string): Promise<number | null> {
  try {
    const signatures = await rpc<Array<{ signature: string; blockTime: number }>>(
      "getSignaturesForAddress",
      [address, { limit: 1 }]
    );

    if (signatures && signatures.length > 0) {
      return (signatures[0].blockTime || 0) * 1000; // Convert to ms
    }
    return null;
  } catch {
    return null;
  }
}

// Cluster wallets by creation time using multiple methods
interface WalletCluster {
  addresses: string[];
  method: "exact_time" | "time_bucket" | "arithmetic_progression" | "fixed_interval";
  description: string;
  timeRange: { min: number; max: number };
}

function clusterWalletsByCreationTime(
  holders: { address: string; createdAt: number | null }[]
): WalletCluster[] {
  const clusters: WalletCluster[] = [];
  const validHolders = holders.filter((h): h is { address: string; createdAt: number } => h.createdAt !== null);

  if (validHolders.length < 2) return [];

  // Method 1: Exact same time (within 1 second tolerance)
  const timeGroups = new Map<number, string[]>();
  for (const h of validHolders) {
    const bucket = Math.floor(h.createdAt / 1000) * 1000; // 1-second buckets
    if (!timeGroups.has(bucket)) {
      timeGroups.set(bucket, []);
    }
    timeGroups.get(bucket)!.push(h.address);
  }

  for (const [time, addresses] of timeGroups) {
    if (addresses.length >= 2) {
      clusters.push({
        addresses,
        method: "exact_time",
        description: `Created at exactly the same time (${new Date(time).toISOString()})`,
        timeRange: { min: time, max: time + 1000 },
      });
    }
  }

  // Method 2: Fixed interval clustering (e.g., every 5 minutes)
  const FIXED_BUCKETS = [5 * 60 * 1000, 60 * 1000, 10 * 60 * 1000]; // 5min, 1min, 10min

  for (const bucketSize of FIXED_BUCKETS) {
    const bucketGroups = new Map<number, string[]>();
    for (const h of validHolders) {
      const bucket = Math.floor(h.createdAt / bucketSize) * bucketSize;
      if (!bucketGroups.has(bucket)) {
        bucketGroups.set(bucket, []);
      }
      bucketGroups.get(bucket)!.push(h.address);
    }

    for (const [bucket, addresses] of bucketGroups) {
      if (addresses.length >= 3) {
        // Only include if not already in exact_time cluster
        const newAddresses = addresses.filter((addr) => {
          return !clusters.some((c) => c.method === "exact_time" && c.addresses.includes(addr));
        });

        if (newAddresses.length >= 3) {
          clusters.push({
            addresses: newAddresses,
            method: "time_bucket",
            description: `Created within same ${bucketSize / 60000}min window`,
            timeRange: { min: bucket, max: bucket + bucketSize },
          });
        }
      }
    }
  }

  // Method 3: Arithmetic progression detection (wallets created with same interval between them)
  const sorted = [...validHolders].sort((a, b) => a.createdAt - b.createdAt);
  const intervals: { start: number; end: number; interval: number; count: number; addresses: string[] }[] = [];

  for (let windowSize = 2; windowSize <= 5; windowSize++) {
    for (let i = 0; i <= sorted.length - windowSize; i++) {
      const window = sorted.slice(i, i + windowSize);
      const gaps: number[] = [];

      for (let j = 1; j < window.length; j++) {
        gaps.push(window[j].createdAt - window[j - 1].createdAt);
      }

      // Check if all gaps are similar (within 10% tolerance)
      if (gaps.length > 1) {
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const maxDeviation = Math.max(...gaps.map((g) => Math.abs(g - avgGap)));

        if (maxDeviation < avgGap * 0.1 && avgGap > 1000) { // At least 1 second between
          intervals.push({
            start: i,
            end: i + windowSize - 1,
            interval: avgGap,
            count: windowSize,
            addresses: window.map((w) => w.address),
          });
        }
      }
    }
  }

  // Merge overlapping intervals
  for (const interval of intervals) {
    const addresses = interval.addresses;
    if (addresses.length >= 3) {
      // Check if not already in other clusters
      const isNew = !clusters.some((c) =>
        addresses.every((addr) => c.addresses.includes(addr))
      );

      if (isNew) {
        clusters.push({
          addresses,
          method: "arithmetic_progression",
          description: `Created with ~${(interval.interval / 1000).toFixed(1)}s interval`,
          timeRange: {
            min: Math.min(...addresses.map((a) => validHolders.find((h) => h.address === a)!.createdAt)),
            max: Math.max(...addresses.map((a) => validHolders.find((h) => h.address === a)!.createdAt)),
          },
        });
      }
    }
  }

  // Method 4: Fixed interval pattern (e.g., every 30 seconds exactly)
  const INTERVAL_PATTERNS = [30000, 60000, 120000, 300000]; // 30s, 1min, 2min, 5min

  for (const pattern of INTERVAL_PATTERNS) {
    const patternGroups: string[][] = [];
    let currentGroup: string[] = [];
    let lastTime: number | null = null;

    for (const h of sorted) {
      if (lastTime === null) {
        currentGroup = [h.address];
        lastTime = h.createdAt;
      } else {
        const gap = h.createdAt - lastTime;
        if (Math.abs(gap - pattern) < pattern * 0.15) { // 15% tolerance
          currentGroup.push(h.address);
          lastTime = h.createdAt;
        } else {
          if (currentGroup.length >= 3) {
            patternGroups.push([...currentGroup]);
          }
          currentGroup = [h.address];
          lastTime = h.createdAt;
        }
      }
    }

    if (currentGroup.length >= 3) {
      patternGroups.push(currentGroup);
    }

    for (const group of patternGroups) {
      const isNew = !clusters.some((c) => group.every((addr) => c.addresses.includes(addr)));

      if (isNew) {
        clusters.push({
          addresses: group,
          method: "fixed_interval",
          description: `Created every ~${pattern / 1000}s (bot pattern)`,
          timeRange: {
            min: Math.min(...group.map((a) => validHolders.find((h) => h.address === a)!.createdAt)),
            max: Math.max(...group.map((a) => validHolders.find((h) => h.address === a)!.createdAt)),
          },
        });
      }
    }
  }

  return clusters;
}

// Get holders by parsing blockchain directly via Helius getProgramAccounts
// This works for ALL tokens including bonding curve
async function getHoldersFromChain(mint: string): Promise<{ address: string; balance: number }[]> {
  try {

    const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    // Get all token accounts holding this mint
    const accounts = await rpc<Array<{
      pubkey: string;
      account: {
        data: {
          parsed: {
            info: {
              owner: string;
              tokenAmount: { uiAmount: number; amount: string; decimals: number };
            };
          };
        };
      };
    }>>("getProgramAccounts", [
      TOKEN_PROGRAM_ID,
      {
        encoding: "jsonParsed",
        filters: [
          { dataSize: 165 }, // Token account size
          { memcmp: { offset: 0, bytes: mint } }, // Filter by mint
        ],
      },
    ]);

    if (!accounts || accounts.length === 0) {
      return [];
    }


    // Aggregate balances by owner (one owner can have multiple token accounts)
    const ownerBalances = new Map<string, number>();

    for (const acc of accounts) {
      const info = acc.account?.data?.parsed?.info;
      if (!info?.owner || !info?.tokenAmount?.uiAmount) continue;

      const balance = info.tokenAmount.uiAmount;
      if (balance <= 0) continue;

      const current = ownerBalances.get(info.owner) || 0;
      ownerBalances.set(info.owner, current + balance);
    }

    // Sort by balance descending and take top 20
    const sorted = normalizeHolders([...ownerBalances.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([address, balance]) => ({ address, balance })));

    return sorted;
  } catch (e) {
    return [];
  }
}

// Pump.fun trade record from swap-api
interface PumpTrade {
  tx: string;
  timestamp: string;
  userAddress: string;
  type: "buy" | "sell";
  program: string;
  priceUsd: string;
  priceSol: string;
  amountUsd: string;
  amountSol: string;
  baseAmount: string;
  quoteAmount: string;
}

function rawTradeToPumpTrade(t: RawTrade): PumpTrade {
  return {
    tx: t.signature,
    timestamp: new Date(t.timestamp * 1000).toISOString(),
    userAddress: t.trader,
    type: t.type === "sell" ? "sell" : "buy",
    program: t.source || "PUMP_FUN",
    priceUsd: "0",
    priceSol: String(t.priceSol),
    amountUsd: "0",
    amountSol: String(t.amountSol),
    baseAmount: String(t.amountTokens),
    quoteAmount: String(t.amountSol),
  };
}

// Fetch all trades from swap-api with pagination
async function fetchAllPumpTrades(mint: string, maxPages = 20): Promise<PumpTrade[]> {
  const cached = await loadTokenTrades(mint, { maxTrades: maxPages * 200 });
  if (cached.length > 0) return cached.map(rawTradeToPumpTrade);

  const all: PumpTrade[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    try {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!res.ok) break;
      const data = await res.json() as { trades?: PumpTrade[]; pagination?: { nextCursor?: string; hasMore?: boolean } };
      if (!data.trades || data.trades.length === 0) break;
      all.push(...data.trades);
      if (!data.pagination?.hasMore || !data.pagination.nextCursor) break;
      cursor = data.pagination.nextCursor;
    } catch {
      break;
    }
  }
  persistTokenTrades(mint, all.map((t) => ({
    signature: t.tx,
    timestamp: Math.floor(new Date(t.timestamp).getTime() / 1000),
    trader: t.userAddress,
    type: t.type,
    amountSol: parseFloat(t.amountSol) || 0,
    amountTokens: parseFloat(t.baseAmount) || 0,
    priceSol: parseFloat(t.priceSol) || 0,
    source: t.program,
  })));
  return all;
}

// Build holder balances by aggregating buys/sells per wallet
function aggregateHoldersFromTrades(trades: PumpTrade[]): { address: string; balance: number }[] {
  const balances = new Map<string, number>();
  for (const t of trades) {
    const amt = parseFloat(t.baseAmount);
    if (!Number.isFinite(amt)) continue;
    const cur = balances.get(t.userAddress) || 0;
    balances.set(t.userAddress, cur + (t.type === "buy" ? amt : -amt));
  }
  return normalizeHolders(Array.from(balances.entries())
    .filter(([, b]) => b > 0.000001)
    .map(([address, balance]) => ({ address, balance }))
    .sort((a, b) => b.balance - a.balance));
}

// Get top 20 holders. Primary source: swap-api.pump.fun trades (no key, no Cloudflare blocks).
async function getTopHolders(mint: string): Promise<{ address: string; balance: number }[]> {
  // Try 1: swap-api.pump.fun trades aggregation (most reliable, no RPC)
  try {
    const trades = await fetchAllPumpTrades(mint);
    if (trades.length > 0) {
      const holders = aggregateHoldersFromTrades(trades);
      if (holders.length > 0) return holders;
    }
  } catch {
    // fall through
  }

  // Try 2: GMGN top holders
  const gmgnHolders = await getHoldersFromGmgn(mint);
  if (gmgnHolders.length > 0) {
    return gmgnHolders;
  }

  // Try 3: Pump.fun holders endpoint
  const pumpHolders = await getHoldersFromPump(mint);
  if (pumpHolders.length > 0) {
    return pumpHolders;
  }

  // Try 4: Birdeye API if key exists
  const birdeyeHolders = await getHoldersFromBirdeye(mint);
  if (birdeyeHolders.length > 0) {
    return birdeyeHolders;
  }

  // Try 5: Solscan API if key exists
  const solscanHolders = await getHoldersFromSolscan(mint);
  if (solscanHolders.length > 0) {
    return solscanHolders;
  }

  // Try 6: SolanaFM public holders endpoint
  const solanaFmHolders = await getHoldersFromSolanaFm(mint);
  if (solanaFmHolders.length > 0) {
    return solanaFmHolders;
  }

  // Try 7: Helius RPC getTokenLargestAccounts (only works on real mainnet RPC)
  try {
    const largest = await rpc<{ value: { address: string; uiAmount: number }[] }>(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }]
    );

    if (largest.value && largest.value.length > 0) {
      const accounts = largest.value.slice(0, 20);
      const result: { address: string; balance: number }[] = [];

      for (const acc of accounts) {
        try {
          const accountInfo = await rpc<{
            value?: { data?: { parsed?: { info?: { owner?: string } } } };
          }>("getAccountInfo", [acc.address, { encoding: "jsonParsed", commitment: "confirmed" }]);

          const owner = accountInfo.value?.data?.parsed?.info?.owner;
          if (owner) {
            result.push({ address: owner, balance: acc.uiAmount || 0 });
          }
        } catch {
          // Skip failed accounts
        }
      }

      if (result.length > 0) {
        return normalizeHolders(result);
      }
    }
  } catch {
  }

  // Try 8: Direct on-chain parsing
  const chainHolders = await getHoldersFromChain(mint);
  if (chainHolders.length > 0) {
    return chainHolders;
  }

  // Try 9: legacy Pump.fun endpoint parser kept as final fallback
  try {
    const res2 = await fetch(`https://frontend-api.pump.fun/coins/${mint}/holders?limit=20&offset=0`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res2.ok) {
      const data = await res2.json() as { holders?: Array<{ address: string; balance: string }> };
      if (data.holders && data.holders.length > 0) {
        return normalizeHolders(data.holders.map((h) => ({
          address: h.address,
          balance: parseFloat(h.balance),
        })));
      }
    }
  } catch (e) {
  }

  return [];
}

// Get transaction history for token mint via swap-api.pump.fun (primary source).
async function getTokenTransactions(mint: string, limit = 1000): Promise<Transaction[]> {
  // Primary: swap-api trades — already paginated in fetchAllPumpTrades; reuse with higher cap
  try {
    const trades = await fetchAllPumpTrades(mint, 25); // up to 5000 trades
    if (trades.length > 0) {
      return trades.map((t): Transaction => {
        const tokenAmount = parseFloat(t.baseAmount) || 0;
        const solAmount = parseFloat(t.amountSol) || 0;
        const priceUsd = parseFloat(t.priceUsd) || 0;
        return {
          signature: t.tx,
          timestamp: new Date(t.timestamp).getTime(),
          type: t.type,
          wallet: t.userAddress,
          tokenAmount,
          solAmount,
          price: priceUsd,
        };
      }).slice(0, limit);
    }
  } catch {
    // fall through to legacy paths
  }

  try {
    // Use Helius enhanced API if available
    for (let index = 0; index < HELIUS_API_KEYS.length; index += 1) {
      const apiKey = HELIUS_API_KEYS[index] ?? "";
      const res = await fetch(appendHeliusApiKey("https://api.helius.xyz/v0/addresses/", apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: {
            accounts: [mint],
            programs: [],
            types: ["TRANSFER", "SWAP"],
          },
          options: {
            limit,
          },
        }),
        cache: "no-store",
      });

      if (!res.ok) {
        if (isHeliusRetryableStatus(res.status) && index < HELIUS_API_KEYS.length - 1) continue;
        break;
      }

      const data = await res.json() as {
        result?: Array<{
          signature: string;
          timestamp: number;
          type: string;
          nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
          tokenTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; tokenAmount: number }>;
        }>;
      };

      if (data.result) {
        return data.result
          .filter((tx) => tx.type === "SWAP" || tx.type === "TRANSFER")
          .map((tx): Transaction => {
            const isBuy = tx.tokenTransfers?.some(
              (t) => t.toUserAccount === mint || t.toUserAccount?.toLowerCase().includes("pump")
            );

            const tokenTransfer = tx.tokenTransfers?.[0];
            const nativeTransfer = tx.nativeTransfers?.[0];

            return {
              signature: tx.signature,
              timestamp: tx.timestamp * 1000,
              type: isBuy ? "buy" : "sell",
              wallet: tokenTransfer?.fromUserAccount || nativeTransfer?.fromUserAccount || "",
              tokenAmount: Number(tokenTransfer?.tokenAmount || 0),
              solAmount: (nativeTransfer?.amount || 0) / 1e9,
              price: 0, // Will calculate later
            };
          })
          .filter((tx) => tx.wallet);
      }
    }

    // Fallback: get signatures and parse transactions
    const sigs = await rpc<Array<{ signature: string; blockTime: number }>>(
      "getSignaturesForAddress",
      [mint, { limit: 100 }]
    );

    const transactions: Transaction[] = [];

    for (const sig of sigs.slice(0, 50)) {
      try {
        const tx = await rpc<{
          transaction?: {
            message?: {
              accountKeys?: string[];
            };
          };
          meta?: {
            preTokenBalances?: Array<{
              accountIndex: number;
              mint: string;
              uiTokenAmount: { uiAmount: number };
              owner: string;
            }>;
            postTokenBalances?: Array<{
              accountIndex: number;
              mint: string;
              uiTokenAmount: { uiAmount: number };
              owner: string;
            }>;
            preBalances?: number[];
            postBalances?: number[];
          };
        }>("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);

        if (!tx.transaction || !tx.meta) continue;

        // Parse token transfers
        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const post of postBalances) {
          if (post.mint !== mint) continue;

          const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
          const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
          const postAmount = post.uiTokenAmount?.uiAmount || 0;
          const diff = postAmount - preAmount;

          if (Math.abs(diff) > 0.000001) {
            const solDiff = ((tx.meta.postBalances?.[0] || 0) - (tx.meta.preBalances?.[0] || 0)) / 1e9;

            transactions.push({
              signature: sig.signature,
              timestamp: (sig.blockTime || 0) * 1000,
              type: diff > 0 ? "buy" : "sell",
              wallet: post.owner,
              tokenAmount: Math.abs(diff),
              solAmount: Math.abs(solDiff),
              price: Math.abs(solDiff / diff) || 0,
            });
          }
        }
      } catch {
        // Skip failed transactions
      }
    }

    return transactions;
  } catch (e) {
    return [];
  }
}

// Calculate P&L for holders
function calculateHolderAnalytics(
  holders: { address: string; balance: number }[],
  transactions: Transaction[],
  devWallet: string | null,
  currentPrice: number
): HolderAnalytics[] {
  const analytics: HolderAnalytics[] = [];

  for (const holder of holders) {
    const walletTxs = transactions.filter((tx) => tx.wallet === holder.address);

    let totalBought = 0;
    let totalSold = 0;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const tx of walletTxs) {
      if (tx.type === "buy") {
        totalBought += tx.tokenAmount;
        buyVolume += tx.solAmount;
      } else {
        totalSold += tx.tokenAmount;
        sellVolume += tx.solAmount;
      }
    }

    const avgBuyPrice = totalBought > 0 ? buyVolume / totalBought : 0;
    const avgSellPrice = totalSold > 0 ? sellVolume / totalSold : 0;

    const realizedPnl = sellVolume - (totalSold * avgBuyPrice);
    const unrealizedPnl = holder.balance * (currentPrice - avgBuyPrice);
    const totalPnl = realizedPnl + unrealizedPnl;
    const roi = buyVolume > 0 ? (totalPnl / buyVolume) * 100 : 0;

    const timestamps = walletTxs.map((tx) => tx.timestamp).filter((t) => t > 0);

    analytics.push({
      address: holder.address,
      tokenBalance: holder.balance,
      totalBought,
      totalSold,
      avgBuyPrice,
      avgSellPrice,
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      roi,
      txCount: walletTxs.length,
      firstBuyTime: timestamps.length > 0 ? Math.min(...timestamps) : null,
      lastActivity: timestamps.length > 0 ? Math.max(...timestamps) : null,
      isDev: holder.address === devWallet,
      connectedToDev: false, // Will detect later
      sybilGroup: null, // Will detect later
    });
  }

  // Detect connections to dev
  if (devWallet) {
    const devFirstBuy = analytics.find((h) => h.isDev)?.firstBuyTime;

    for (const h of analytics) {
      if (h.isDev) continue;

      // Connected if bought within 5 minutes of dev's first buy
      if (devFirstBuy && h.firstBuyTime) {
        const timeDiff = Math.abs(h.firstBuyTime - devFirstBuy);
        if (timeDiff < 5 * 60 * 1000) {
          h.connectedToDev = true;
        }
      }
    }
  }

  // Simple sybil detection: group by similar first buy time
  const timeGroups: Map<number, string[]> = new Map();

  for (const h of analytics) {
    if (!h.firstBuyTime) continue;

    // Round to 10-second buckets
    const bucket = Math.floor(h.firstBuyTime / 10000) * 10000;

    if (!timeGroups.has(bucket)) {
      timeGroups.set(bucket, []);
    }
    timeGroups.get(bucket)!.push(h.address);
  }

  let groupId = 1;
  for (const [_, wallets] of timeGroups) {
    if (wallets.length >= 2) {
      // These wallets bought at similar time - potential sybil
      for (const addr of wallets) {
        const h = analytics.find((a) => a.address === addr);
        if (h) h.sybilGroup = groupId;
      }
      groupId++;
    }
  }

  return analytics.sort((a, b) => b.totalPnl - a.totalPnl);
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }

  try {

    // Get dev wallet
    const devWallet = await getDevWallet(mint);

    // Get top holders
    const holders = await getTopHolders(mint);

    if (holders.length === 0) {
      return NextResponse.json({ error: "Holders not found. Token may not be on pump.fun or RPC is unavailable." }, { status: 200 });
    }

    // Get wallet creation times for clustering (rate-limited)
    const holdersWithCreationTime: { address: string; balance: number; createdAt: number | null }[] = [];

    // Process sequentially to avoid rate limiting
    for (const h of holders.slice(0, 15)) { // Limit to 15 to avoid timeouts
      await new Promise((resolve) => setTimeout(resolve, 100)); // 100ms delay between requests
      const createdAt = await getWalletCreationTime(h.address);
      holdersWithCreationTime.push({ ...h, createdAt });
    }

    // Perform clustering analysis
    const clusters = clusterWalletsByCreationTime(holdersWithCreationTime);

    // Get transaction history
    const transactions = await getTokenTransactions(mint);

    // Get current token price from DexScreener
    let currentPrice = 0;
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        cache: "no-store",
      });
      if (dexRes.ok) {
        const dexData = await dexRes.json() as { pairs?: Array<{ priceUsd?: number; priceNative?: number }> };
        currentPrice = dexData.pairs?.[0]?.priceUsd || dexData.pairs?.[0]?.priceNative || 0;
      }
    } catch {
      // Ignore price fetch errors
    }

    // Calculate analytics
    const analytics = calculateHolderAnalytics(holders, transactions, devWallet, currentPrice);

    // Add creation time to analytics
    for (const a of analytics) {
      const withTime = holdersWithCreationTime.find((h) => h.address === a.address);
      if (withTime) {
        (a as any).createdAt = withTime.createdAt;
      }
    }

    // Build sybil groups from clusters
    const sybilGroups: string[][] = clusters.map((c) => c.addresses);

    // Add cluster info to holders
    for (const a of analytics) {
      for (const cluster of clusters) {
        if (cluster.addresses.includes(a.address)) {
          (a as any).clusterMethod = cluster.method;
          (a as any).clusterDescription = cluster.description;
        }
      }
    }

    const response: AnalyticsResponse & { clusters: WalletCluster[] } = {
      mint,
      devWallet,
      holders: analytics,
      sybilGroups,
      clusters,
      tokenPrice: currentPrice,
    };

    return NextResponse.json(response);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
