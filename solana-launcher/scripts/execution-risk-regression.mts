import { assessExecutionRisk, type QuoteProvider } from "../lib/trade/execution-risk.ts";
import { extractOwnerTokenDelta, reconcileExpectedCredit } from "../lib/trade/position-reconciliation.ts";
import { evaluateSellPolicies } from "../lib/trade/sell-policy-engine.ts";
import { canonicalizeLesson, promoteRepeatedLessons, summarizeTradeOutcomes } from "../lib/trade/execution-learning.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[execution-risk-regression] ${message}`);
}

function provider(sequence: Array<Record<string, unknown> | null>): QuoteProvider {
  let index = 0;
  return async () => sequence[index++] as Awaited<ReturnType<QuoteProvider>>;
}

const safe = await assessExecutionRisk({
  quote: provider([
    { inAmount: "100000000", outAmount: "1000000", priceImpactPct: "0.01", routePlan: [{}] },
    { inAmount: "250000", outAmount: "24000000", priceImpactPct: "0.02", routePlan: [{}] },
    { inAmount: "1000000", outAmount: "95000000", priceImpactPct: "0.03", routePlan: [{}, {}] },
  ]),
  outputMint: "TokenMint1111111111111111111111111111111111",
  inputAmountRaw: "100000000",
});
assert(safe.allowed, "healthy roundtrip should pass");
assert(Math.abs((safe.grossRoundtripLossPct ?? 0) - 5) < 0.001, "roundtrip loss must be computed from raw amounts");

const highImpact = await assessExecutionRisk({
  quote: provider([{ inAmount: "100", outAmount: "1000", priceImpactPct: "0.25", routePlan: [{}] }]),
  outputMint: "TokenMint1111111111111111111111111111111111",
  inputAmountRaw: "100",
  maxPriceImpactPct: 0.15,
});
assert(highImpact.reason === "buy_price_impact", "high-impact entry must be blocked");

const noExit = await assessExecutionRisk({
  quote: provider([
    { inAmount: "100", outAmount: "1000", priceImpactPct: "0.01", routePlan: [{}] },
    { inAmount: "250", outAmount: "0", priceImpactPct: "0", routePlan: [] },
  ]),
  outputMint: "TokenMint1111111111111111111111111111111111",
  inputAmountRaw: "100",
});
assert(noExit.reason === "exit_no_route", "missing reverse route must be blocked");

const delta = extractOwnerTokenDelta({
  preTokenBalances: [{ mint: "M", owner: "O", uiTokenAmount: { amount: "100", decimals: 2 } }],
  postTokenBalances: [{ mint: "M", owner: "O", uiTokenAmount: { amount: "260", decimals: 2 } }],
}, { mint: "M", owner: "O" });
assert(delta?.deltaRaw === "160", "transaction reconciliation must use post-pre token delta");
assert(delta?.deltaUi === 1.6, "token delta UI conversion must respect decimals");
const reconciled = reconcileExpectedCredit({ expectedRaw: "160", txDelta: delta, tolerancePct: 2 });
assert(reconciled.reconciled, "matching tx credit must reconcile");

const rugExit = evaluateSellPolicies({
  mint: "M", acquiredAt: 1_000, pnlNetPct: -2, peakPnlNetPct: 3, rugSeverity: 0.95,
}, { now: 20_000 });
assert(rugExit.action === "sell_all" && rugExit.reason === "RUG_FORCE_EXIT", "rug signal must outrank min-hold and ordinary policies");

const uncertainQuote = evaluateSellPolicies({
  mint: "M", acquiredAt: 1_000, pnlNetPct: -20, peakPnlNetPct: 1, quoteTrust: 0.2,
}, { now: 200_000 });
assert(uncertainQuote.action === "hold" && uncertainQuote.reason === "QUOTE_UNCERTAIN_RECONCILE_FIRST", "bad quote must request reconciliation instead of creating a false stop");

const hardStop = evaluateSellPolicies({
  mint: "M", acquiredAt: 1_000, pnlNetPct: -15, peakPnlNetPct: 0,
}, { now: 400_000 });
assert(hardStop.action === "sell_all" && hardStop.reason.startsWith("HARD_STOP_"), "hard stop must fire after guard window");

const profitLockArm = evaluateSellPolicies({
  mint: "M", acquiredAt: 1_000, pnlNetPct: 20, peakPnlNetPct: 20,
}, { now: 400_000 });
assert(profitLockArm.action === "sell_partial" && profitLockArm.statePatch?.profitLockArmed === true, "profit lock must arm once and return a state patch");
const profitLock = evaluateSellPolicies({
  mint: "M", acquiredAt: 1_000, pnlNetPct: 8, peakPnlNetPct: 20, profitLockArmed: true, profitLockHarvested: true, profitLockFloorPct: 11,
}, { now: 400_000 });
assert(profitLock.action === "sell_all" && profitLock.reason === "PROFIT_LOCK_STOP", "armed profit lock must protect retained peak profit");

const fade = evaluateSellPolicies({
  mint: "M",
  acquiredAt: 1_000,
  pnlNetPct: 3,
  peakPnlNetPct: 5,
  samples: [
    { at: 1, pnlPct: 5 }, { at: 2, pnlPct: 4.7 }, { at: 3, pnlPct: 4.2 }, { at: 4, pnlPct: 3.6 }, { at: 5, pnlPct: 3 },
  ],
}, { now: 30_000, config: { profitLockArmPct: 10 } });
assert(fade.action === "sell_all" && fade.reason === "PNL_FADE_EXIT", "multi-sample PnL fade must trigger after a meaningful peak/drop");

const normalized = canonicalizeLesson("Avoid 9abcDefghjkmNPqrstUVWXYZ123456789abcd after -12.5% in 0.10 SOL");
assert(normalized.includes("<mint>") && normalized.includes("<num>"), "lesson canonicalization must remove mint/number noise");

const outcomes = [
  { ts: 3, mint: "A", pnlSol: -0.1, decisionSource: "agent", lesson: "Avoid thin exit liquidity after social spike" },
  { ts: 2, mint: "B", pnlSol: -0.2, decisionSource: "agent", lesson: "Avoid thin exit liquidity after social spike" },
  { ts: 1, mint: "C", pnlSol: -0.3, decisionSource: "agent", lesson: "Avoid thin exit liquidity after social spike" },
];
const rules = promoteRepeatedLessons(outcomes, { minRepeats: 3 });
assert(rules.length === 1 && rules[0].hits === 3, "repeated lessons must promote into one stable rule");
const summary = summarizeTradeOutcomes(outcomes);
assert(summary.n === 3 && summary.winRate === 0 && summary.pendingCritiques.length === 3, "outcome summary must expose win-rate and missing agent critiques");

console.log("[execution-risk-regression] OK: preflight, reconciliation, sell policies and outcome evolution are guarded");
