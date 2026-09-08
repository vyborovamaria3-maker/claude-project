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
  getCache,
  setCache,
  recordAnalyzedMint,
  persistWalletSnapshots,
} from "@/lib/trade/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_TXS = 1500;
const FRESH_CHECK_LIMIT = 20;
const BALANCE_CHECK_LIMIT = 60;
const ANALYSIS_SCHEMA_VERSION = 2;
const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60_000;
const RAW_TRADES_IN_RESPONSE = 1500;
const EARLY_TRADES_IN_RESPONSE = 300;

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
        const cacheKey = analysisCacheKey(mint);
        if (!skipCache) {
          const cached = getCache<unknown>("analysis_cache", cacheKey);
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
            send({
              type: "progress",
              phase: fromCache ? "cached-trades" : "fetching",
              fetched,
              page,
            });
          },
        });

        if (trades.length === 0) {
          const payload = {
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
            mint,
            summary: {
              totalVolumeSol: 0,
              totalVolumeUsd: null,
              totalTrades: 0,
              totalRawTrades: 0,
              uniqueWallets: 0,
              historyTruncated: false,
              maxTradesRequested: MAX_TXS,
            },
            wallets: [],
            dev: null,
            bundles: [],
            timeline: [],
            trades: [],
            truncated: false,
            fetchedAt: Date.now(),
            note: "No trades detected for this mint",
          };
          setCache("analysis_cache", cacheKey, payload, ANALYSIS_CACHE_TTL_MS);
          send({ type: "final", ...payload });
          controller.close();
          return;
        }

        send({ type: "progress", phase: "classifying", fetched: trades.length, page: 0 });

        const historyTruncated = trades.length >= MAX_TXS;
        const walletsMap = aggregateByWallet(trades);
        let currentPriceSol = 0;
        let latestTs = -Infinity;
        for (const trade of trades) {
          if (trade.timestamp > latestTs) {
            latestTs = trade.timestamp;
            currentPriceSol = trade.priceSol;
          }
        }

        const { bundles, walletBundleId } = detectBundles(trades);
        const coBuyMap = findRelatedWallets(trades);
        const allWallets = Array.from(walletsMap.values()).sort((a, b) => b.volumeSol - a.volumeSol);
        const topAddrs = allWallets.slice(0, BALANCE_CHECK_LIMIT).map((wallet) => wallet.address);
        const freshCheckAddrs = allWallets.slice(0, FRESH_CHECK_LIMIT).map((wallet) => wallet.address);

        send({ type: "progress", phase: "enriching", fetched: trades.length, page: 0 });

        const firstSeenMap = new Map<string, number | null>();
        const [solBalances] = await Promise.all([
          fetchSolBalances(topAddrs),
          Promise.all(
            freshCheckAddrs.map(async (address) => {
              firstSeenMap.set(address, await cachedFirstSeen(address));
            }),
          ),
        ]);

        const nowSec = Date.now() / 1000;
        const rows = allWallets.map((wallet, index) => {
          const pnl = calcFifoPnL(wallet.trades, currentPriceSol);
          const wash = detectWashTrading(wallet);
          const globalFirstSeen = firstSeenMap.get(wallet.address);
          const freshnessVerified = index < FRESH_CHECK_LIMIT && globalFirstSeen != null;
          const pnlComplete = !historyTruncated
            && wallet.totalTokensSold <= wallet.totalTokensBought + 1e-9;
          return {
            address: wallet.address,
            buys: safeNumber(wallet.buys),
            sells: safeNumber(wallet.sells),
            volumeSol: safeNumber(wallet.volumeSol),
            pnlSol: safeNumber(pnl.pnlSol),
            pnlPercent: safeNumber(pnl.pnlPercent),
            pnlComplete,
            pnlMethod: "token-local-fifo-mark-to-market",
            solBalance: solBalances.get(wallet.address) ?? null,
            balanceVerified: index < BALANCE_CHECK_LIMIT && solBalances.has(wallet.address),
            tokenBalanceUsd: null,
            isFresh: freshnessVerified ? isFreshWallet(globalFirstSeen, nowSec) : null,
            freshnessVerified,
            firstSeenGlobal: freshnessVerified ? globalFirstSeen : null,
            firstSeenOnToken: wallet.firstSeen,
            isSmart: false,
            smartClassificationAvailable: false,
            isWashTrader: wash.isSuspicious,
            washConfidence: wash.confidence,
            washReasons: wash.reasons,
            bundleId: walletBundleId.get(wallet.address),
            bundleMethod: walletBundleId.has(wallet.address)
              ? "synchronous-buy-5s-amount-within-5pct"
              : null,
            coBuyProximityCount: coBuyMap.get(wallet.address)?.size ?? 0,
            coBuyProximityWindowSec: 30,
            historyTruncated,
          };
        });

        const totalVolumeSol = trades.reduce((sum, trade) => sum + safeNumber(trade.amountSol), 0);
        const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
        let tradesForUi = sortedTrades;
        if (sortedTrades.length > RAW_TRADES_IN_RESPONSE) {
          const earlyCount = Math.min(EARLY_TRADES_IN_RESPONSE, RAW_TRADES_IN_RESPONSE);
          tradesForUi = [
            ...sortedTrades.slice(0, earlyCount),
            ...sortedTrades.slice(-(RAW_TRADES_IN_RESPONSE - earlyCount)),
          ];
        }
        const compactTrades = tradesForUi.map((trade) => ({
          ts: safeNumber(trade.timestamp),
          w: trade.trader,
          t: trade.type === "buy" ? 1 : 0,
          s: roundNumber(trade.amountSol, 6),
          n: roundNumber(trade.amountTokens, 6),
          p: roundNumber(trade.priceSol, 12),
          sig: trade.signature,
          u: roundNumber(safeNumber(trade.amountSol) * 150, 2),
        }));

        const earliest = sortedTrades[0]?.timestamp ?? null;
        const latest = sortedTrades[sortedTrades.length - 1]?.timestamp ?? null;
        const summary = {
          totalVolumeSol,
          totalVolumeUsd: null,
          totalTrades: trades.length,
          totalRawTrades: trades.length,
          uniqueWallets: walletsMap.size,
          periodStart: earliest,
          periodEnd: latest,
          historyTruncated,
          maxTradesRequested: MAX_TXS,
        };

        const payload = {
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          mint,
          summary,
          wallets: rows,
          dev: null,
          bundles: bundles.map((bundle) => ({
            id: bundle.bundleId,
            size: bundle.wallets.length,
            totalVolumeSol: safeNumber(bundle.totalVolumeSol),
            wallets: bundle.wallets,
            method: "synchronous-buy-5s-amount-within-5pct",
            heuristic: true,
          })),
          timeline: [],
          trades: compactTrades,
          truncated: historyTruncated,
          fetchedAt: Date.now(),
        };

        setCache("analysis_cache", cacheKey, payload, ANALYSIS_CACHE_TTL_MS);

        try {
          recordAnalyzedMint({
            mint,
            totalVolumeSol,
            totalTrades: trades.length,
            uniqueWallets: walletsMap.size,
            periodStart: earliest,
            periodEnd: latest,
          });
          persistWalletSnapshots(
            mint,
            rows.map((row) => ({
              address: row.address,
              mint,
              buys: row.buys,
              sells: row.sells,
              volumeSol: row.volumeSol,
              pnlSol: row.pnlSol,
              pnlPercent: row.pnlPercent,
              isFresh: row.isFresh === true,
              isWash: row.isWashTrader,
              bundleId: row.bundleId ?? null,
              firstSeen: row.firstSeenGlobal ?? null,
            })),
          );
        } catch {
          // Persistence is non-blocking for analysis delivery.
        }

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
