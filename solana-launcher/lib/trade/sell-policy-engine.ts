export type SellAction = "hold" | "sell_partial" | "sell_all";

export type PnlSample = { at: number; pnlPct: number };

export type SellPolicyPosition = {
  mint: string;
  acquiredAt: number;
  lastBuyAt?: number | null;
  pnlNetPct: number;
  peakPnlNetPct: number;
  drawdownFromHighPct?: number | null;
  pendingCredit?: boolean;
  rugSeverity?: number | null;
  momentum?: "accelerating" | "stable" | "decelerating" | "unknown";
  quoteTrust?: number | null;
  roundtripLossPct?: number | null;
  samples?: PnlSample[];
  profitLockArmed?: boolean;
  profitLockHarvested?: boolean;
  profitLockFloorPct?: number | null;
};

export type SellPolicyConfig = {
  minHoldMs: number;
  hardStopPct: number;
  earlyHardStopWindowMs: number;
  earlyHardStopFloorPct: number;
  rugForceSeverity: number;
  profitLockArmPct: number;
  profitLockRetainFraction: number;
  profitLockBreakevenCushionPct: number;
  profitLockHarvestPct: number;
  fadeMinAgeMs: number;
  fadeMinPeakPct: number;
  fadeDropFromPeakPct: number;
  fadeDowntrendPoints: number;
  fadeEpsilonPct: number;
  lowQuoteTrustThreshold: number;
  maxRoundtripLossPct: number;
};

export type SellDecision = {
  action: SellAction;
  pct: number | null;
  reason: string;
  priority: number;
  tags: string[];
  diagnostics: Record<string, number | boolean | string | null>;
  statePatch?: Partial<Pick<SellPolicyPosition, "profitLockArmed" | "profitLockHarvested" | "profitLockFloorPct">>;
};

export const DEFAULT_SELL_POLICY_CONFIG: SellPolicyConfig = Object.freeze({
  minHoldMs: 5_000,
  hardStopPct: 12,
  earlyHardStopWindowMs: 180_000,
  earlyHardStopFloorPct: 12,
  rugForceSeverity: 0.85,
  profitLockArmPct: 10,
  profitLockRetainFraction: 0.55,
  profitLockBreakevenCushionPct: 0.6,
  profitLockHarvestPct: 30,
  fadeMinAgeMs: 12_000,
  fadeMinPeakPct: 2,
  fadeDropFromPeakPct: 0.75,
  fadeDowntrendPoints: 3,
  fadeEpsilonPct: 0.05,
  lowQuoteTrustThreshold: 0.45,
  maxRoundtripLossPct: 35,
});

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function configWithDefaults(overrides?: Partial<SellPolicyConfig>): SellPolicyConfig {
  const c = { ...DEFAULT_SELL_POLICY_CONFIG, ...(overrides || {}) };
  return {
    minHoldMs: clamp(Number(c.minHoldMs), 0, 3_600_000),
    hardStopPct: clamp(Number(c.hardStopPct), 0.1, 99),
    earlyHardStopWindowMs: clamp(Number(c.earlyHardStopWindowMs), 0, 3_600_000),
    earlyHardStopFloorPct: clamp(Number(c.earlyHardStopFloorPct), 0.1, 99),
    rugForceSeverity: clamp(Number(c.rugForceSeverity), 0, 1),
    profitLockArmPct: clamp(Number(c.profitLockArmPct), 0, 1_000),
    profitLockRetainFraction: clamp(Number(c.profitLockRetainFraction), 0.05, 0.95),
    profitLockBreakevenCushionPct: clamp(Number(c.profitLockBreakevenCushionPct), 0, 100),
    profitLockHarvestPct: clamp(Number(c.profitLockHarvestPct), 0, 100),
    fadeMinAgeMs: clamp(Number(c.fadeMinAgeMs), 0, 300_000),
    fadeMinPeakPct: clamp(Number(c.fadeMinPeakPct), 0, 100),
    fadeDropFromPeakPct: clamp(Number(c.fadeDropFromPeakPct), 0.05, 25),
    fadeDowntrendPoints: Math.round(clamp(Number(c.fadeDowntrendPoints), 2, 10)),
    fadeEpsilonPct: clamp(Number(c.fadeEpsilonPct), 0, 2),
    lowQuoteTrustThreshold: clamp(Number(c.lowQuoteTrustThreshold), 0, 1),
    maxRoundtripLossPct: clamp(Number(c.maxRoundtripLossPct), 0, 100),
  };
}

function countTrailingDeclines(samples: PnlSample[], epsilon: number) {
  let count = 0;
  for (let i = samples.length - 1; i > 0; i -= 1) {
    const previous = Number(samples[i - 1]?.pnlPct);
    const current = Number(samples[i]?.pnlPct);
    if (!Number.isFinite(previous) || !Number.isFinite(current)) break;
    if (current <= previous - epsilon) count += 1;
    else break;
  }
  return count;
}

export function evaluateSellPolicies(
  position: SellPolicyPosition,
  { now = Date.now(), config }: { now?: number; config?: Partial<SellPolicyConfig> } = {},
): SellDecision {
  const c = configWithDefaults(config);
  const ageMs = Math.max(0, now - Number(position.lastBuyAt || position.acquiredAt || now));
  const pnl = Number(position.pnlNetPct);
  const peak = Math.max(Number(position.peakPnlNetPct), pnl);
  const rugSeverity = clamp(Number(position.rugSeverity || 0), 0, 1);
  const quoteTrust = position.quoteTrust == null ? null : clamp(Number(position.quoteTrust), 0, 1);
  const roundtripLoss = position.roundtripLossPct == null ? null : Number(position.roundtripLossPct);
  const diagnostics: Record<string, number | boolean | string | null> = {
    ageMs,
    pnlNetPct: pnl,
    peakPnlNetPct: peak,
    rugSeverity,
    quoteTrust,
    roundtripLossPct: roundtripLoss,
    pendingCredit: !!position.pendingCredit,
    momentum: position.momentum || "unknown",
  };

  if (rugSeverity >= c.rugForceSeverity) {
    return { action: "sell_all", pct: 100, reason: "RUG_FORCE_EXIT", priority: 100, tags: ["rug", "urgent"], diagnostics };
  }

  // Never use uncertain quotes as an excuse for an ordinary forced exit. A low-trust
  // quote is evidence to refresh/reconcile first, unless an independent rug signal exists.
  if (quoteTrust != null && quoteTrust < c.lowQuoteTrustThreshold) {
    return { action: "hold", pct: null, reason: "QUOTE_UNCERTAIN_RECONCILE_FIRST", priority: 95, tags: ["quote-uncertain", "reconcile"], diagnostics };
  }

  if (position.pendingCredit) {
    return { action: "hold", pct: null, reason: "PENDING_CREDIT_RECONCILIATION", priority: 90, tags: ["pending-credit", "reconcile"], diagnostics };
  }

  if (roundtripLoss != null && roundtripLoss > c.maxRoundtripLossPct) {
    diagnostics.exitLiquidityWarning = true;
  }

  const minHoldActive = ageMs < c.minHoldMs;
  const earlyStopFloor = ageMs < c.earlyHardStopWindowMs ? c.earlyHardStopFloorPct : 0;
  const hardStop = Math.max(c.hardStopPct, earlyStopFloor);
  if (!minHoldActive && Number.isFinite(pnl) && pnl <= -Math.abs(hardStop)) {
    return { action: "sell_all", pct: 100, reason: `HARD_STOP_${hardStop.toFixed(2)}PCT`, priority: 80, tags: ["hard-stop"], diagnostics };
  }

  const computedLockFloor = Math.max(c.profitLockBreakevenCushionPct, peak * c.profitLockRetainFraction);
  const persistedLockFloor = Number(position.profitLockFloorPct);
  const lockFloor = Number.isFinite(persistedLockFloor)
    ? Math.max(computedLockFloor, persistedLockFloor)
    : computedLockFloor;
  const lockArmed = position.profitLockArmed === true;
  const shouldArmLock = !lockArmed && pnl >= c.profitLockArmPct;
  if (lockArmed || shouldArmLock) {
    diagnostics.profitLockFloorPct = lockFloor;
    const statePatch = {
      profitLockArmed: true,
      profitLockFloorPct: lockFloor,
      ...(shouldArmLock && c.profitLockHarvestPct > 0 ? { profitLockHarvested: true } : {}),
    };
    if (lockArmed && pnl <= lockFloor) {
      return { action: "sell_all", pct: 100, reason: "PROFIT_LOCK_STOP", priority: 70, tags: ["profit-lock"], diagnostics, statePatch };
    }
    if (shouldArmLock && !position.profitLockHarvested && c.profitLockHarvestPct > 0) {
      return { action: "sell_partial", pct: c.profitLockHarvestPct, reason: "PROFIT_LOCK_ARM_HARVEST", priority: 50, tags: ["profit-lock", "harvest"], diagnostics, statePatch };
    }
  }

  const samples = (position.samples || []).filter((sample) => Number.isFinite(sample.pnlPct)).slice(-12);
  const declines = countTrailingDeclines(samples, c.fadeEpsilonPct);
  const dropFromPeak = peak - pnl;
  diagnostics.fadeDeclines = declines;
  diagnostics.dropFromPeakPct = dropFromPeak;
  if (
    ageMs >= c.fadeMinAgeMs
    && peak >= c.fadeMinPeakPct
    && pnl > 0
    && dropFromPeak >= c.fadeDropFromPeakPct
    && declines >= c.fadeDowntrendPoints
  ) {
    return { action: "sell_all", pct: 100, reason: "PNL_FADE_EXIT", priority: 60, tags: ["fade", "momentum-loss"], diagnostics };
  }

  if (position.momentum === "decelerating" && dropFromPeak >= Math.max(2, c.fadeDropFromPeakPct * 2)) {
    return { action: "sell_partial", pct: 25, reason: "MOMENTUM_COOLING_DE_RISK", priority: 40, tags: ["momentum", "de-risk"], diagnostics };
  }

  return { action: "hold", pct: null, reason: minHoldActive ? "MIN_HOLD" : "NO_EXIT_TRIGGER", priority: 0, tags: minHoldActive ? ["min-hold"] : [], diagnostics };
}
