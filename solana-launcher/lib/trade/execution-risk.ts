export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type SwapQuote = {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string | number;
  routePlan?: unknown[];
  [key: string]: unknown;
};

export type QuoteProvider = (request: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}) => Promise<SwapQuote | null>;

export type ExecutionRiskReason =
  | "invalid_request"
  | "buy_quote_failed"
  | "buy_no_route"
  | "buy_price_impact"
  | "exit_quote_failed"
  | "exit_no_route"
  | "exit_price_impact"
  | "roundtrip_quote_failed"
  | "roundtrip_loss";

export type ExecutionRiskResult = {
  allowed: boolean;
  reason: ExecutionRiskReason | null;
  inputAmountRaw: string;
  expectedOutputRaw: string | null;
  exitCheckAmountRaw: string | null;
  priceImpactPct: number | null;
  exitPriceImpactPct: number | null;
  routeHops: number | null;
  exitRouteHops: number | null;
  grossRoundtripLossPct: number | null;
  grossRoundtripReturnPct: number | null;
  notes: string[];
  quotes: {
    buy: SwapQuote | null;
    exitCheck: SwapQuote | null;
    fullRoundtrip: SwapQuote | null;
  };
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safePositiveBigInt(value: unknown): bigint {
  try {
    const parsed = BigInt(String(value ?? "0"));
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function routeHops(quote: SwapQuote | null): number | null {
  return Array.isArray(quote?.routePlan) ? quote.routePlan.length : null;
}

function hasRoute(quote: SwapQuote | null) {
  if (!quote) return false;
  if (safePositiveBigInt(quote.outAmount) <= 0n) return false;
  const hops = routeHops(quote);
  return hops == null || hops > 0;
}

export async function assessExecutionRisk({
  quote,
  inputMint = WSOL_MINT,
  outputMint,
  inputAmountRaw,
  slippageBps = 250,
  maxPriceImpactPct = 0.15,
  exitCheckFraction = 0.25,
  maxGrossRoundtripLossPct = 20,
}: {
  quote: QuoteProvider;
  inputMint?: string;
  outputMint: string;
  inputAmountRaw: string;
  slippageBps?: number;
  maxPriceImpactPct?: number;
  exitCheckFraction?: number;
  maxGrossRoundtripLossPct?: number;
}): Promise<ExecutionRiskResult> {
  const notes: string[] = [];
  const inputRaw = safePositiveBigInt(inputAmountRaw);
  const slip = Math.trunc(clamp(Number(slippageBps) || 250, 1, 20_000));
  const maxImpact = clamp(Number(maxPriceImpactPct) || 0.15, 0.001, 0.95);
  const fraction = clamp(Number(exitCheckFraction) || 0.25, 0.01, 1);
  const maxLoss = clamp(Number(maxGrossRoundtripLossPct) || 20, 0, 100);

  const empty = (reason: ExecutionRiskReason): ExecutionRiskResult => ({
    allowed: false,
    reason,
    inputAmountRaw: inputRaw.toString(),
    expectedOutputRaw: null,
    exitCheckAmountRaw: null,
    priceImpactPct: null,
    exitPriceImpactPct: null,
    routeHops: null,
    exitRouteHops: null,
    grossRoundtripLossPct: null,
    grossRoundtripReturnPct: null,
    notes,
    quotes: { buy: null, exitCheck: null, fullRoundtrip: null },
  });

  if (!inputMint || !outputMint || inputMint === outputMint || inputRaw <= 0n || typeof quote !== "function") {
    notes.push("Invalid mint pair, amount, or quote provider.");
    return empty("invalid_request");
  }

  let buy: SwapQuote | null = null;
  try {
    buy = await quote({ inputMint, outputMint, amount: inputRaw.toString(), slippageBps: slip });
  } catch {
    // Caller receives deterministic reason without leaking upstream details.
  }
  if (!buy) return empty("buy_quote_failed");
  if (!hasRoute(buy)) return { ...empty("buy_no_route"), quotes: { buy, exitCheck: null, fullRoundtrip: null } };

  const outputRaw = safePositiveBigInt(buy.outAmount);
  const buyImpact = finiteNumber(buy.priceImpactPct);
  if (buyImpact != null && buyImpact >= maxImpact) {
    notes.push(`Buy price impact ${(buyImpact * 100).toFixed(2)}% exceeds ${(maxImpact * 100).toFixed(2)}% limit.`);
    return {
      ...empty("buy_price_impact"),
      expectedOutputRaw: outputRaw.toString(),
      priceImpactPct: buyImpact,
      routeHops: routeHops(buy),
      quotes: { buy, exitCheck: null, fullRoundtrip: null },
    };
  }

  const scale = 1_000_000n;
  const fractionScaled = BigInt(Math.max(1, Math.floor(fraction * Number(scale))));
  const exitCheckRaw = (outputRaw * fractionScaled) / scale;
  if (exitCheckRaw <= 0n) return { ...empty("exit_no_route"), quotes: { buy, exitCheck: null, fullRoundtrip: null } };

  let exitCheck: SwapQuote | null = null;
  try {
    exitCheck = await quote({ inputMint: outputMint, outputMint: inputMint, amount: exitCheckRaw.toString(), slippageBps: slip });
  } catch {
    // See above.
  }
  if (!exitCheck) {
    return {
      ...empty("exit_quote_failed"),
      expectedOutputRaw: outputRaw.toString(),
      exitCheckAmountRaw: exitCheckRaw.toString(),
      priceImpactPct: buyImpact,
      routeHops: routeHops(buy),
      quotes: { buy, exitCheck: null, fullRoundtrip: null },
    };
  }
  if (!hasRoute(exitCheck)) {
    return {
      ...empty("exit_no_route"),
      expectedOutputRaw: outputRaw.toString(),
      exitCheckAmountRaw: exitCheckRaw.toString(),
      priceImpactPct: buyImpact,
      routeHops: routeHops(buy),
      quotes: { buy, exitCheck, fullRoundtrip: null },
    };
  }

  const exitImpact = finiteNumber(exitCheck.priceImpactPct);
  if (exitImpact != null && exitImpact >= maxImpact) {
    notes.push(`Exit-check price impact ${(exitImpact * 100).toFixed(2)}% exceeds ${(maxImpact * 100).toFixed(2)}% limit.`);
    return {
      ...empty("exit_price_impact"),
      expectedOutputRaw: outputRaw.toString(),
      exitCheckAmountRaw: exitCheckRaw.toString(),
      priceImpactPct: buyImpact,
      exitPriceImpactPct: exitImpact,
      routeHops: routeHops(buy),
      exitRouteHops: routeHops(exitCheck),
      quotes: { buy, exitCheck, fullRoundtrip: null },
    };
  }

  let fullRoundtrip: SwapQuote | null = null;
  try {
    fullRoundtrip = await quote({ inputMint: outputMint, outputMint: inputMint, amount: outputRaw.toString(), slippageBps: slip });
  } catch {
    // See above.
  }
  if (!fullRoundtrip || !hasRoute(fullRoundtrip)) {
    return {
      ...empty("roundtrip_quote_failed"),
      expectedOutputRaw: outputRaw.toString(),
      exitCheckAmountRaw: exitCheckRaw.toString(),
      priceImpactPct: buyImpact,
      exitPriceImpactPct: exitImpact,
      routeHops: routeHops(buy),
      exitRouteHops: routeHops(exitCheck),
      quotes: { buy, exitCheck, fullRoundtrip },
    };
  }

  const backRaw = safePositiveBigInt(fullRoundtrip.outAmount);
  const inputNumber = Number(inputRaw);
  const backNumber = Number(backRaw);
  const returnPct = inputNumber > 0 && Number.isFinite(inputNumber) && Number.isFinite(backNumber)
    ? (backNumber / inputNumber) * 100
    : null;
  const lossPct = returnPct == null ? null : Math.max(-10_000, 100 - returnPct);

  if (lossPct != null && lossPct > maxLoss) {
    notes.push(`Gross immediate roundtrip loss ${lossPct.toFixed(2)}% exceeds ${maxLoss.toFixed(2)}% limit.`);
    notes.push("Roundtrip estimate excludes network fees and ATA rent; it is a liquidity/route guard, not a guaranteed realized PnL.");
    return {
      allowed: false,
      reason: "roundtrip_loss",
      inputAmountRaw: inputRaw.toString(),
      expectedOutputRaw: outputRaw.toString(),
      exitCheckAmountRaw: exitCheckRaw.toString(),
      priceImpactPct: buyImpact,
      exitPriceImpactPct: exitImpact,
      routeHops: routeHops(buy),
      exitRouteHops: routeHops(exitCheck),
      grossRoundtripLossPct: lossPct,
      grossRoundtripReturnPct: returnPct,
      notes,
      quotes: { buy, exitCheck, fullRoundtrip },
    };
  }

  notes.push("A reverse route exists for both the partial exit check and the full quoted output.");
  notes.push("Roundtrip estimate excludes network fees and ATA rent; execution must still simulate the final transaction.");
  return {
    allowed: true,
    reason: null,
    inputAmountRaw: inputRaw.toString(),
    expectedOutputRaw: outputRaw.toString(),
    exitCheckAmountRaw: exitCheckRaw.toString(),
    priceImpactPct: buyImpact,
    exitPriceImpactPct: exitImpact,
    routeHops: routeHops(buy),
    exitRouteHops: routeHops(exitCheck),
    grossRoundtripLossPct: lossPct,
    grossRoundtripReturnPct: returnPct,
    notes,
    quotes: { buy, exitCheck, fullRoundtrip },
  };
}
