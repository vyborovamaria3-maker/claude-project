import { describe, expect, it } from "vitest";
import { evaluateSafety } from "./full";

describe("chain safety evidence semantics", () => {
  it("keeps unavailable Token-2022 extension data unknown", () => {
    const checks = evaluateSafety({
      mintAuthority: undefined,
      freezeAuthority: undefined,
      lpLockedPct: null,
      lpBurnedPct: null,
      honeypotSellOk: null,
      transferTaxPct: null,
      upgradeable: null,
      permanentDelegate: undefined,
      transferHookProgramId: undefined,
      defaultAccountState: undefined,
      nonTransferable: undefined,
    }, "fixture", 1);
    for (const id of ["permanent_delegate", "transfer_hook", "default_frozen", "non_transferable"]) {
      expect(checks.find((row) => row.id === id)?.status).toBe("unknown");
    }
  });

  it("distinguishes checked-absent extensions from unavailable data", () => {
    const checks = evaluateSafety({
      mintAuthority: null,
      freezeAuthority: null,
      lpLockedPct: null,
      lpBurnedPct: null,
      honeypotSellOk: null,
      transferTaxPct: 0,
      upgradeable: null,
      permanentDelegate: null,
      transferHookProgramId: null,
      defaultAccountState: null,
      nonTransferable: false,
    }, "fixture", 1);
    expect(checks.find((row) => row.id === "permanent_delegate")?.status).toBe("ok");
    expect(checks.find((row) => row.id === "transfer_hook")?.status).toBe("ok");
    expect(checks.find((row) => row.id === "non_transferable")?.status).toBe("ok");
  });
});
