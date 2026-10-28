import { describe, expect, it } from "vitest";
import {
  evaluateHoodHuntWallet,
  type ObservedSwap,
} from "./hood-hunt-wallet";
import {
  evaluateDevPresets, simulateDevSnipe, type DevLaunchEvidence,
} from "./hood-hunt-dev";

const WALLET = "targetWallet";
const NOW = 1_800_000_000;

function swap(
  mint: string, slot: number, trader: string,
  side: "buy" | "sell", price: number, sol: number, tokens: number,
  includeCosts = true,
): ObservedSwap {
  return {
    mint, slot, trader, side, priceSol: price, amountSol: sol, amountTokens: tokens,
    signature: mint + "-" + slot + "-" + trader, timestamp: NOW - 3600 + slot,
    feeSol: includeCosts ? 0 : null, tipSol: includeCosts ? 0 : null,
  };
}

describe("Hood Hunt wallet evidence model", () => {
  it("computes closed-token PF and win-rate, not a trade-count win-rate", () => {
    const trades = [
      swap("M1", 10, WALLET, "buy", 1, 1, 1),
      swap("M1", 11, "other", "buy", 1.1, 1.1, 1),
      swap("M1", 20, WALLET, "sell", 2, 2, 1),
      swap("M1", 21, "other", "sell", 2.1, 2.1, 1),
      swap("M2", 30, WALLET, "buy", 1, 1, 1),
      swap("M2", 31, "other", "buy", 1.1, 1.1, 1),
      swap("M2", 40, WALLET, "sell", 0.5, 0.5, 1),
      swap("M2", 41, "other", "sell", 0.4, 0.4, 1),
    ];
    const out = evaluateHoodHuntWallet({
      wallet: WALLET, trades, nowSec: NOW, balanceSol: 2,
      creationSlots: { M1: 1, M2: 1 },
      tokenCreators: { M1: "someone", M2: "someone" },
    });
    expect(out.closedTokens).toBe(2);
    expect(out.pnlSol).toBeCloseTo(0.5);
    expect(out.profitFactor).toBeCloseTo(2);
    expect(out.winRate).toBe(0.5);
    expect(out.medianHoldSeconds).toBe(10);
    expect(out.modeledCopy.samples).toBe(2);
    expect(out.modeledCopy.profitableRate).toBe(0.5);
    expect(out.sniperEntryRate).toBe(0);
  });

  it("keeps an unsold position out of realized PnL and sample win-rate", () => {
    const out = evaluateHoodHuntWallet({
      wallet: WALLET,
      trades: [swap("OPEN", 5, WALLET, "buy", 1, 1, 1)],
      nowSec: NOW,
    });
    expect(out.closedTokens).toBe(0);
    expect(out.pnlSol).toBeNull();
    expect(out.winRate).toBeNull();
    expect(out.tokens[0].closed).toBe(false);
  });

  it("flags missing fee or creation slot evidence rather than recommending copying", () => {
    const out = evaluateHoodHuntWallet({
      wallet: WALLET, nowSec: NOW,
      trades: [
        swap("FEE", 10, WALLET, "buy", 1, 1, 1, false),
        swap("FEE", 20, WALLET, "sell", 2, 2, 1, false),
        swap("FEE", 11, "other", "buy", 1.1, 1.1, 1),
        swap("FEE", 21, "other", "sell", 2.1, 2.1, 1),
      ],
    });
    expect(out.status).toBe("Проверить");
    expect(out.sniperEntryRate).toBeNull();
    expect(out.limitations.some((line) => line.includes("fees/tips"))).toBe(true);
  });

  it("never invents next-trade copy ROI when the exit price is absent", () => {
    const out = evaluateHoodHuntWallet({
      wallet: WALLET,
      trades: [
        swap("NO_EXIT", 10, WALLET, "buy", 1, 1, 1),
        swap("NO_EXIT", 11, "other", "buy", 1.1, 1.1, 1),
        swap("NO_EXIT", 20, WALLET, "sell", 2, 2, 1),
      ],
    });
    expect(out.closedTokens).toBe(1);
    expect(out.modeledCopy.samples).toBe(0);
    expect(out.modeledCopy.averageRoiPct).toBeNull();
  });
});

function devLaunch(i: number): DevLaunchEvidence {
  return {
    mint: "D" + i, symbol: "S" + i, createdAt: NOW - i * 3600,
    athUsd: 50_000, firstSecondMarketCapUsd: 6_000,
    afterBundleMarketCapUsd: 8_000,
    bundleEndedAtSeconds: 10,
    firstDevSellAtSeconds: 15,
    earlyDevSell: false,
    pricePath: [
      { secondsAfterLaunch: 10, marketCapUsd: 8_000 },
      { secondsAfterLaunch: 15, marketCapUsd: 9_000 },
      { secondsAfterLaunch: 60, marketCapUsd: 20_000 },
    ],
  };
}

describe("Hood Hunt DEV presets", () => {
  it("simulates first target hit within 30 minutes, net of explicit estimated costs", () => {
    const result = simulateDevSnipe(devLaunch(1));
    expect(result?.exitReason).toBe("target");
    expect(result?.entryMarketCapUsd).toBe(8_000);
    expect(result?.roiPct).toBeGreaterThan(0);
  });

  it("stops before a later target hit after a 50% drawdown", () => {
    const test = devLaunch(1);
    test.pricePath = [
      { secondsAfterLaunch: 10, marketCapUsd: 8_000 },
      { secondsAfterLaunch: 20, marketCapUsd: 3_800 },
      { secondsAfterLaunch: 60, marketCapUsd: 20_000 },
    ];
    expect(simulateDevSnipe(test)?.exitReason).toBe("stop");
  });

  it("does not infer missing intralaunch evidence from an ATH alone", () => {
    const results = evaluateDevPresets({
      creator: "dev", nowSec: NOW, launches: [
        { mint: "UNKNOWN", createdAt: NOW - 60, athUsd: 100_000 },
      ],
    });
    for (const preset of Object.values(results.presets)) {
      expect(preset.verdict).toBe("Недостаточно данных");
      expect(preset.simulationSamples).toBe(0);
    }
  });

  it("evaluates local strict criteria only on complete observed launches", () => {
    const results = evaluateDevPresets({
      creator: "dev", nowSec: NOW,
      launches: Array.from({ length: 5 }, (_, i) => devLaunch(i + 1)),
    });
    expect(results.presets.Strict.verdict).toBe("Снайпить");
    expect(results.presets["Dev sell"].simulationSamples).toBe(5);
  });
});
