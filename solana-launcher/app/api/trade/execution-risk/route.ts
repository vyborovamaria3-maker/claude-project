import { NextRequest, NextResponse } from "next/server";
import { assessExecutionRisk, WSOL_MINT, type QuoteProvider, type SwapQuote } from "@/lib/trade/execution-risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJupiterProvider(): QuoteProvider {
  const apiKey = String(process.env.JUPITER_API_KEY || "").trim();
  const base = String(
    process.env.JUPITER_SWAP_API_URL
      || (apiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1"),
  ).replace(/\/$/, "");
  const configuredInterval = Number(process.env.JUPITER_QUOTE_MIN_INTERVAL_MS);
  const minIntervalMs = Number.isFinite(configuredInterval)
    ? clamp(configuredInterval, 0, 10_000)
    : (apiKey ? 120 : 2_100);
  let lastRequestAt = 0;

  return async ({ inputMint, outputMint, amount, slippageBps }) => {
    const wait = minIntervalMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);

    const url = new URL(`${base}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("restrictIntermediateTokens", "true");

    lastRequestAt = Date.now();
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      signal: AbortSignal.timeout(9_000),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`Jupiter quote HTTP ${response.status}${message ? `: ${message.slice(0, 180)}` : ""}`);
    }
    return await response.json() as SwapQuote;
  };
}

function summarizedQuote(quote: SwapQuote | null) {
  if (!quote) return null;
  return {
    inAmount: String(quote.inAmount || ""),
    outAmount: String(quote.outAmount || ""),
    priceImpactPct: quote.priceImpactPct == null ? null : Number(quote.priceImpactPct),
    routeHops: Array.isArray(quote.routePlan) ? quote.routePlan.length : null,
  };
}

// EXECUTION_RISK_LOCAL_LIMIT: fallback when proxy.ts has no safely identifiable heavy-route collection.
const EXECUTION_RISK_LOCAL_LIMIT = 10;
const EXECUTION_RISK_LOCAL_WINDOW_MS = 60_000;
const EXECUTION_RISK_LOCAL_MAX_KEYS = 5_000;
const executionRiskLocalRequests = new Map<string, { count: number; resetAt: number }>();

function executionRiskClientIp(req: NextRequest): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && realIp.length <= 64) return realIp;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

function checkExecutionRiskLocalRateLimit(req: NextRequest): NextResponse | null {
  const now = Date.now();
  const windowId = Math.floor(now / EXECUTION_RISK_LOCAL_WINDOW_MS);
  const resetAt = (windowId + 1) * EXECUTION_RISK_LOCAL_WINDOW_MS;
  const key = `${executionRiskClientIp(req)}:${windowId}`;
  const current = executionRiskLocalRequests.get(key);

  if (!current) {
    if (executionRiskLocalRequests.size >= EXECUTION_RISK_LOCAL_MAX_KEYS) {
      for (const [candidate, entry] of executionRiskLocalRequests) {
        if (entry.resetAt <= now) executionRiskLocalRequests.delete(candidate);
      }
    }
    if (executionRiskLocalRequests.size >= EXECUTION_RISK_LOCAL_MAX_KEYS) {
      const oldest = executionRiskLocalRequests.keys().next().value as string | undefined;
      if (oldest) executionRiskLocalRequests.delete(oldest);
    }
    executionRiskLocalRequests.set(key, { count: 1, resetAt });
    return null;
  }

  if (current.count >= EXECUTION_RISK_LOCAL_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return NextResponse.json(
      { error: "Too many execution-risk requests", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  current.count += 1;
  return null;
}

export async function GET(req: NextRequest) {
  const localRateLimitError = checkExecutionRiskLocalRateLimit(req);
  if (localRateLimitError) return localRateLimitError;
  const mint = req.nextUrl.searchParams.get("mint")?.trim() || "";
  if (!MINT_RE.test(mint) || mint === WSOL_MINT) {
    return NextResponse.json({ error: "invalid mint" }, { status: 400 });
  }

  const inputSol = clamp(Number(req.nextUrl.searchParams.get("inputSol") || 0.1), 0.001, 100);
  const slippageBps = Math.round(clamp(Number(req.nextUrl.searchParams.get("slippageBps") || 250), 1, 20_000));
  const maxPriceImpactPct = clamp(Number(req.nextUrl.searchParams.get("maxPriceImpactPct") || 0.15), 0.001, 0.95);
  const maxGrossRoundtripLossPct = clamp(Number(req.nextUrl.searchParams.get("maxRoundtripLossPct") || 20), 0, 100);
  const inputAmountRaw = BigInt(Math.max(1, Math.floor(inputSol * 1e9))).toString();

  try {
    const result = await assessExecutionRisk({
      quote: createJupiterProvider(),
      outputMint: mint,
      inputAmountRaw,
      slippageBps,
      maxPriceImpactPct,
      exitCheckFraction: 0.25,
      maxGrossRoundtripLossPct,
    });

    return NextResponse.json({
      mint,
      inputSol,
      slippageBps,
      checkedAt: new Date().toISOString(),
      allowed: result.allowed,
      reason: result.reason,
      priceImpactPct: result.priceImpactPct,
      exitPriceImpactPct: result.exitPriceImpactPct,
      grossRoundtripLossPct: result.grossRoundtripLossPct,
      grossRoundtripReturnPct: result.grossRoundtripReturnPct,
      routeHops: result.routeHops,
      exitRouteHops: result.exitRouteHops,
      expectedOutputRaw: result.expectedOutputRaw,
      notes: result.notes,
      quotes: {
        buy: summarizedQuote(result.quotes.buy),
        exitCheck: summarizedQuote(result.quotes.exitCheck),
        fullRoundtrip: summarizedQuote(result.quotes.fullRoundtrip),
      },
      model: "fdv-derived-execution-preflight-v1",
      caveat: "Quote-only guard. It does not sign/send a transaction and does not guarantee realized exit price.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "execution risk check failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
