// Read-only decisions for locally maintained targets. A "pause" recommendation
// is not a Blizz trading command and cannot itself stop any live orders.

export type ManagedTargetKind = "wallet" | "dev";
export type ManagedTargetState = "watch" | "active" | "paused" | "removed";
export type ManagedTargetVerdict = "Копировать" | "Снайпить" | "Следить" | "Проверить" | "Пропустить";

export interface ManagedTargetSignals {
  kind: ManagedTargetKind;
  state: ManagedTargetState;
  latestVerdict: ManagedTargetVerdict | null;
  pnl7dSol: number | null;
  balanceSol: number | null;
  consecutiveLiveLosses: number | null;
  lastReviewedAt: number | null; // Unix milliseconds, null if never reviewed
}

export interface ManagedTargetDecision {
  suggestedState: ManagedTargetState;
  requiresReview: boolean;
  reasons: string[];
}

export function evaluateManagedTarget(
  target: ManagedTargetSignals,
  nowMs: number = Date.now(),
): ManagedTargetDecision {
  const reasons: string[] = [];
  if (target.state === "removed") {
    return { suggestedState: "removed", requiresReview: false, reasons: ["Target has already been removed."] };
  }
  const needsReview = target.lastReviewedAt === null
    || !Number.isFinite(target.lastReviewedAt)
    || nowMs - target.lastReviewedAt >= 24 * 60 * 60 * 1000;
  if (needsReview) reasons.push("Scheduled daily review is due.");
  if (target.pnl7dSol !== null && target.pnl7dSol < 0) {
    reasons.push("Seven-day PnL is negative.");
  }
  if (target.balanceSol !== null && target.balanceSol < 0.1) {
    reasons.push("Wallet SOL balance is below 0.1.");
  }
  if (target.consecutiveLiveLosses !== null && target.consecutiveLiveLosses >= 3) {
    reasons.push("At least three consecutive live losses.");
  }
  if (target.latestVerdict === "Пропустить") {
    reasons.push("Latest analytics verdict is Пропустить.");
  }
  const shouldPause = reasons.some((reason) => reason !== "Scheduled daily review is due.");
  return {
    suggestedState: shouldPause && target.state === "active" ? "paused" : target.state,
    requiresReview: needsReview || shouldPause,
    reasons,
  };
}
