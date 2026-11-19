import { describe, expect, it } from "vitest";
import { evaluateManagedTarget, type ManagedTargetSignals } from "./hood-hunt-strategy";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const target: ManagedTargetSignals = {
  kind: "wallet", state: "active", latestVerdict: "Следить",
  pnl7dSol: 2, balanceSol: 3, consecutiveLiveLosses: 0,
  lastReviewedAt: NOW - DAY_MS / 2,
};

describe("managed strategy review", () => {
  it("keeps a functioning active target when review is not due", () => {
    const out = evaluateManagedTarget(target, NOW);
    expect(out.suggestedState).toBe("active");
    expect(out.requiresReview).toBe(false);
    expect(out.reasons).toEqual([]);
  });

  it("schedules daily review without incorrectly pausing a positive target", () => {
    const out = evaluateManagedTarget({ ...target, lastReviewedAt: NOW - DAY_MS }, NOW);
    expect(out.suggestedState).toBe("active");
    expect(out.requiresReview).toBe(true);
  });

  it("recommends local pause on three live losses or negative 7d PnL", () => {
    expect(evaluateManagedTarget({ ...target, consecutiveLiveLosses: 3 }, NOW).suggestedState).toBe("paused");
    expect(evaluateManagedTarget({ ...target, pnl7dSol: -0.01 }, NOW).suggestedState).toBe("paused");
  });

  it("does not resurrect a removed target", () => {
    const out = evaluateManagedTarget({ ...target, state: "removed", pnl7dSol: -5 }, NOW);
    expect(out.suggestedState).toBe("removed");
    expect(out.requiresReview).toBe(false);
  });

  it("keeps unknown data distinct from negative observations", () => {
    const out = evaluateManagedTarget({
      ...target, pnl7dSol: null, balanceSol: null,
      consecutiveLiveLosses: null, latestVerdict: null,
    }, NOW);
    expect(out.suggestedState).toBe("active");
  });
});
