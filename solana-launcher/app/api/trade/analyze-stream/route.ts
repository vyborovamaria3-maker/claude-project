// data-tag: api.trade.analyze-stream
// Streaming variant of /api/trade/analyze. Sends NDJSON events:
//   {type:"progress", fetched, page}
//   {type:"final", ...payload}
//   {type:"error", message}
import { NextRequest } from "next/server";
import { fetchSolBalances, getWalletFirstSeen } from "@/lib/trade/helius";
import { loadTokenTrades } from "@/lib/trade/trade-cache";
import { requireProdAuth } from "@/lib/routeAuth";
import {
  aggregateByWallet,
  calcFifoPnL,
  detectBundles,
  detectWashTrading,
  findRelatedWallets,
  isFreshWallet,
} from "@/lib/trade/classify";
import {
  getCache, setCache,
  recordAnalyzedMint, persistWalletSnapshots,
} from "@/lib/trade/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_TXS = 1500;            // balanced for faster token history loading
const FRESH_CHECK_LIMIT = 20;    // top-20 by volume
const BALANCE_CHECK_LIMIT = 60;  // top-60 by volume (one batched RPC)
const ANALYSIS_SCHEMA_VERSION = 2;
const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60_000;
const RAW_TRADES_IN_RESPONSE = 2000;
const EARLY_TRADES_IN_RESPONSE = 400;

const firstSeenMemo = new Map<string, { ts: number | null; cachedAt: number }>();
const FIRST_SEEN_TTL_MS = 6 * 60 * 60 * 1000;

async function cachedFirstSeen(addr: string) {
  const hit = firstSeenMemo.get(addr);
  if (hit && Date.now() - hit.cachedAt < FIRST_SEEN_TTL_MS) return hit.ts;
  const ts = await getWalletFirstSeen(addr);
  firstSeenMemo.set(addr, { ts, cachedAt: Date.now() });
  return ts;
}

function analysisCacheKey(mint: string) {
  return `v${ANALYSIS_SCHEMA_VERSION}:${mint}`;
}

function safeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: unknown, decimals: number) {
  return Number(safeNumber(value).toFixed(decimals));
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  const skipCache = req.nextUrl.searchParams.get("refresh") === "1";

  if (!mint || !MINT_RE.test(mint)) {
    return new Response(JSON.stringify({ error: "invalid mint" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        // Cache hit вЂ” return immediately as a single "final" event
        if (!skipCache) {
          const cached = getCache<unknown>("analysis_cache", analysisCacheKey(mint));
          if (cached) {
            send({ type: "final", ...(cached as object), fromCache: true });
            controller.close();
            return;
          }
        }

        send({ type: "progress", phase: "fetching", fetched: 0, page: 0 });

        const trades = await loadTokenTrades(mint, {
          maxTrades: MAX_TXS,
          refresh: skipCache,
          onProgress: ({ fetched, page, fromCache }) => {
            if (fromCache) {
              send({ type: "progress", phase: "cached-trades", fetched, page });
              return;
            }
          send({ type: "progress", phase: "fetching", fetched, page });
          },
        });

        if (trades.length === 0) {
          const payload = {
            mint,
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
            summary: { totalVolumeSol: 0, totalVolumeUsd: 0, totalTrades: 0, uniqueWallets: 0, historyTruncated: false },
            wallets: [], dev: null, bundles: [], timeline: [],
            trades: [],
            fetchedAt: Date.now(),
            note: "No trades detected for this mint",
          };
          setCache("analysis_cache", analysisCacheKey(mint), payload, ANALYSIS_CACHE_TTL_MS);
          send({ type: "final", ...payload });
          controller.close();
          return;
        }

        send({ type: "progress", phase: "classifying", fetched: trades.length, page: 0 });

        const walletsMap = aggregateByWallet(trades);
        let currentPriceSol = 0;
        let latestTs = -Infinity;
        for (const t of trades) {
          if (t.timestamp > latestTs) { latestTs = t.timestamp; currentPriceSol = t.priceSol; }
        }
        const { bundles, walletBundleId } = detectBundles(trades);
        const relatedMap = findRelatedWallets(trades);
        const allWallets = Array.from(walletsMap.values()).sort((a, b) => b.volumeSol - a.volumeSol);
        const topAddrs = allWallets.slice(0, BALANCE_CHECK_LIMIT).map((w) => w.address);
        const freshCheckAddrs = allWallets.slice(0, FRESH_CHECK_LIMIT).map((w) => w.address);

        send({ type: "progress", phase: "enriching", fetched: trades.length, page: 0 });

        const firstSeenMap = new Map<string, number | null>();
        const [solBalances] = await Promise.all([
          fetchSolBalances(topAddrs),
          Promise.all(freshCheckAddrs.map(async (a) => { firstSeenMap.set(a, await cachedFirstSeen(a)); })),
        ]);

        const nowSec = Date.now() / 1000;
        const rows = allWallets.map((w) => {
          const pnl = calcFifoPnL(w.trades, currentPriceSol);
          const wash = detectWashTrading(w);
          const firstSeenGlobal = firstSeenMap.get(w.address) ?? w.firstSeen;
          return {
            address: w.address, buys: w.buys, sells: w.sells, volumeSol: w.volumeSol,
            pnlSol: pnl.pnlSol, pnlPercent: pnl.pnlPercent,
            solBalance: solBalances.get(w.address) ?? 0, tokenBalanceUsd: 0,
            isFresh: firstSeenGlobal ? isFreshWallet(firstSeenGlobal, nowSec) : false,
            freshnessVerified: firstSeenMap.has(w.address),
            isSmart: false, isWashTrader: wash.isSuspicious, washReasons: wash.reasons,
            smartClassificationAvailable: false,
            washConfidence: wash.isSuspicious ? 80 : 0,
            historyTruncated: trades.length >= MAX_TXS,
            pnlComplete: !Number.isNaN(pnl.pnlSol),
            bundleId: walletBundleId.get(w.address),
            relatedCount: relatedMap.get(w.address)?.size ?? 0,
            firstSeen: firstSeenGlobal,
          };
        });

        const totalVolumeSol = trades.reduce((s, t) => s + t.amountSol, 0);
        const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
        let tradesForUi = sortedTrades;
        if (sortedTrades.length > RAW_TRADES_IN_RESPONSE) {
          tradesForUi = [
            ...sortedTrades.slice(0, EARLY_TRADES_IN_RESPONSE),
            ...sortedTrades.slice(-(RAW_TRADES_IN_RESPONSE - EARLY_TRADES_IN_RESPONSE)),
          ];
        }
        const compactTrades = tradesForUi.map((t) => ({
          ts: t.timestamp, w: t.trader, t: t.type === "buy" ? 1 : 0,
          s: roundNumber(t.amountSol, 6), n: roundNumber(t.amountTokens, 6),
          p: roundNumber(t.priceSol, 12), sig: t.signature,
          u: roundNumber(t.amountSol * 150, 2),
        }));

        const earliest = sortedTrades[0]?.timestamp ?? null;
        const latest = sortedTrades[sortedTrades.length - 1]?.timestamp ?? null;
        const summary = {
          totalVolumeSol, totalVolumeUsd: 0, totalTrades: trades.length,
          uniqueWallets: walletsMap.size,
          periodStart: earliest, periodEnd: latest, totalRawTrades: trades.length,
          maxTradesRequested: MAX_TXS,
          historyTruncated: trades.length >= MAX_TXS || sortedTrades.length > RAW_TRADES_IN_RESPONSE,
        };

        const payload = {
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          mint, summary, wallets: rows, dev: null,
          bundles: bundles.map((b) => ({ id: b.bundleId, size: b.wallets.length, totalVolumeSol: b.totalVolumeSol, wallets: b.wallets })),
          timeline: [], trades: compactTrades,
          truncated: summary.historyTruncated,
          fetchedAt: Date.now(),
        };

        setCache("analysis_cache", analysisCacheKey(mint), payload, ANALYSIS_CACHE_TTL_MS);

        try {
          recordAnalyzedMint({
            mint, totalVolumeSol, totalTrades: trades.length, uniqueWallets: walletsMap.size,
            periodStart: earliest, periodEnd: latest,
          });
          persistWalletSnapshots(mint, rows.map((r) => ({
            address: r.address, mint, buys: r.buys, sells: r.sells,
            volumeSol: r.volumeSol, pnlSol: r.pnlSol, pnlPercent: r.pnlPercent,
            isFresh: r.isFresh, isWash: r.isWashTrader, bundleId: r.bundleId ?? null,
            firstSeen: r.firstSeen ?? null,
          })));
        } catch {}

        send({ type: "final", ...payload });
        controller.close();
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
