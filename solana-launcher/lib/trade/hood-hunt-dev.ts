// Pure, evidence-gated DEV presets. Preset thresholds are local configurable
// policies inspired by Hood Hunt, not a claim of exact external proprietary rules.
// Missing evidence never counts as failure or success.

export type DevPreset = "Strict" | "Upside" | "Fast start" | "After bundle" | "Dev sell";
export type DevVerdict = "Снайпить" | "Следить" | "Проверить" | "Пропустить" | "Недостаточно данных";

export interface DevMarketPoint {
  secondsAfterLaunch: number;
  marketCapUsd: number;
}

export interface DevLaunchEvidence {
  mint: string;
  symbol?: string | null;
  createdAt: number | null; // Unix seconds
  athUsd: number | null;
  firstSecondMarketCapUsd?: number | null;
  bundleEndedAtSeconds?: number | null;
  afterBundleMarketCapUsd?: number | null;
  earlyDevSell?: boolean | null;
  firstDevSellAtSeconds?: number | null;
  bundleOwnedSupplyPct?: number | null;
  pricePath?: DevMarketPoint[] | null;
}

export interface SnipingSimulation {
  mint: string;
  strategy: "after_bundle" | "dev_sell";
  entryMarketCapUsd: number;
  exitMarketCapUsd: number;
  exitReason: "target" | "stop" | "timeout";
  roiPct: number;
}

export interface DevPresetAssessment {
  preset: DevPreset;
  verdict: DevVerdict;
  reasons: string[];
  sampleSize: number;
  hit20kRate: number | null;
  clean20kRate: number | null;
  earlyDevSellRate: number | null;
  medianUpsideMultiple: number | null;
  simulationSamples: number;
  averageSimulationRoiPct: number | null;
  profitableSimulationRate: number | null;
}

export interface DevAssessment {
  creator: string;
  recentLaunches: number;
  totalLaunches: number;
  lastLaunchAt: number | null;
  presets: Record<DevPreset, DevPresetAssessment>;
  warnings: string[];
  note: string;
}

export interface DevSimulationCosts {
  feePerSideRate: number;
  tipAsFractionOfEntry: number;
}
const DEFAULT_COSTS: DevSimulationCosts = {
  feePerSideRate: 0.01,
  tipAsFractionOfEntry: 0.002,
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const n = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[n] : (arr[n - 1] + arr[n]) / 2;
};
const rate = (values: Array<boolean | null>): number | null => {
  const observed = values.filter((v): v is boolean => v !== null);
  return observed.length ? observed.filter(Boolean).length / observed.length : null;
};

export function simulateDevSnipe(
  launch: DevLaunchEvidence,
  strategy: "after_bundle" | "dev_sell" = "after_bundle",
  costs: DevSimulationCosts = DEFAULT_COSTS,
): SnipingSimulation | null {
  const entryAfter = strategy === "after_bundle"
    ? launch.bundleEndedAtSeconds : launch.firstDevSellAtSeconds;
  if (!finite(entryAfter) || entryAfter < 0 || !launch.pricePath?.length) return null;
  if (![costs.feePerSideRate, costs.tipAsFractionOfEntry].every(finite)
      || costs.feePerSideRate < 0 || costs.tipAsFractionOfEntry < 0) return null;
  const path = [...launch.pricePath]
    .filter((p) => finite(p.secondsAfterLaunch) && finite(p.marketCapUsd)
      && p.secondsAfterLaunch >= 0 && p.marketCapUsd > 0)
    .sort((a, b) => a.secondsAfterLaunch - b.secondsAfterLaunch);
  const entry = path.find((p) => p.secondsAfterLaunch >= entryAfter && p.secondsAfterLaunch <= entryAfter + 10);
  if (!entry) return null; // Entry has no sufficiently timely observed price.
  const following = path.filter((p) =>
    p.secondsAfterLaunch > entry.secondsAfterLaunch &&
    p.secondsAfterLaunch <= entry.secondsAfterLaunch + 1800);
  if (!following.length) return null;
  const exit = following.find((p) => p.marketCapUsd >= 20_000 || p.marketCapUsd <= entry.marketCapUsd * 0.5)
    ?? following.at(-1)!;
  const reason: SnipingSimulation["exitReason"] = exit.marketCapUsd >= 20_000
    ? "target" : exit.marketCapUsd <= entry.marketCapUsd * 0.5 ? "stop" : "timeout";
  const grossMultiple = exit.marketCapUsd / entry.marketCapUsd;
  const roiPct = Math.max(-100, Math.min(1000, (
    grossMultiple * (1 - costs.feePerSideRate)
    - 1 - costs.feePerSideRate - 2 * costs.tipAsFractionOfEntry
  ) * 100));
  return {
    mint: launch.mint, strategy, entryMarketCapUsd: entry.marketCapUsd,
    exitMarketCapUsd: exit.marketCapUsd, exitReason: reason, roiPct,
  };
}

function cleanTarget(launch: DevLaunchEvidence): boolean | null {
  if (!launch.pricePath?.length || !finite(launch.bundleEndedAtSeconds)) return null;
  const valid = launch.pricePath
    .filter((p) => finite(p.secondsAfterLaunch) && finite(p.marketCapUsd)
      && p.secondsAfterLaunch >= launch.bundleEndedAtSeconds! && p.secondsAfterLaunch <= 1800
      && p.marketCapUsd > 0)
    .sort((a, b) => a.secondsAfterLaunch - b.secondsAfterLaunch);
  if (!valid.length) return null;
  const entry = valid[0].marketCapUsd;
  const target = valid.findIndex((p) => p.marketCapUsd >= 20_000);
  if (target < 0) return false;
  return !valid.slice(0, target + 1).some((p) => p.marketCapUsd <= entry * 0.5);
}

export function evaluateDevPresets(args: {
  creator: string;
  launches: DevLaunchEvidence[];
  nowSec?: number;
}): DevAssessment {
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const byMint = new Map<string, DevLaunchEvidence>();
  for (const item of args.launches) {
    if (!item.mint || (finite(item.createdAt) && item.createdAt > nowSec + 60)) continue;
    const previous = byMint.get(item.mint);
    if (!previous || Number(previous.athUsd == null) < Number(item.athUsd != null)) byMint.set(item.mint, item);
  }
  const launches = [...byMint.values()]
    .sort((a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity))
    .slice(0, 50);
  const lastLaunchAt = launches.find((l) => finite(l.createdAt))?.createdAt ?? null;
  const recent = launches.filter((l) => finite(l.createdAt) && l.createdAt >= nowSec - 86400);
  const hit20k = rate(launches.map((l) => finite(l.athUsd) ? l.athUsd >= 20_000 : null));
  const clean20k = rate(launches.map(cleanTarget));
  const earlySaleRate = rate(launches.map((l) => l.earlyDevSell ?? null));
  const upside = launches
    .filter((l) => finite(l.athUsd) && finite(l.firstSecondMarketCapUsd)
      && l.firstSecondMarketCapUsd > 0)
    .map((l) => l.athUsd! / l.firstSecondMarketCapUsd!);
  const upsideMedian = median(upside);
  const afterBundle = launches.map((l) => simulateDevSnipe(l, "after_bundle")).filter((x): x is SnipingSimulation => x !== null);
  const devSell = launches.map((l) => simulateDevSnipe(l, "dev_sell")).filter((x): x is SnipingSimulation => x !== null);
  const results = {} as Record<DevPreset, DevPresetAssessment>;
  const warnings: string[] = [];
  if (recent.length > 5) warnings.push("More than 5 launches observed in the last day; manual review recommended.");
  if (upside.some((value) => value > 50)) warnings.push("At least one >50x upside launch; verify input market-cap evidence.");
  const symbols = launches.map((l) => (l.symbol ?? "").trim().toLowerCase()).filter(Boolean);
  if (new Set(symbols).size < symbols.length) warnings.push("Repeated token tickers detected.");
  const initialCaps = launches.map((l) => l.firstSecondMarketCapUsd)
    .filter((v): v is number => finite(v) && v > 0);
  const medianInitialCap = median(initialCaps);
  const afterBundleCaps = launches.map((l) => l.afterBundleMarketCapUsd)
    .filter((v): v is number => finite(v) && v > 0);
  const afterBundleMedian = median(afterBundleCaps);
  const presets: DevPreset[] = ["Strict", "Upside", "Fast start", "After bundle", "Dev sell"];
  for (const preset of presets) {
    const simulation = preset === "Dev sell" ? devSell : afterBundle;
    const avg = simulation.length
      ? simulation.reduce((sum, x) => sum + x.roiPct, 0) / simulation.length : null;
    const profitable = simulation.length
      ? simulation.filter((x) => x.roiPct > 0).length / simulation.length : null;
    const reasons: string[] = [];
    let verdict: DevVerdict = "Недостаточно данных";
    const adequate = launches.length >= 5 && hit20k != null && clean20k != null
      && earlySaleRate != null && simulation.length >= 5;
    if (!adequate) reasons.push("At least 5 comparable launches with ATH, clean path, DEV sale and execution-path evidence are required.");
    else if (earlySaleRate! >= 0.8 || hit20k! < 0.2 || avg! < 0) {
      verdict = "Пропустить";
      reasons.push("Failed target hit-rate, early DEV selling, or modeled ROI eligibility.");
    } else if (warnings.length > 0) {
      verdict = "Проверить";
      reasons.push(...warnings);
    } else if (earlySaleRate! >= 0.5) {
      verdict = "Следить";
      reasons.push("DEV sells early in at least half of observed launches.");
    } else {
      const common = hit20k! >= 0.5 && clean20k! >= 0.8
        && earlySaleRate! < 0.2 && avg! >= 0 && lastLaunchAt != null
        && nowSec - lastLaunchAt <= 7 * 86400 && recent.length <= 5;
      const matched = preset === "Strict" ? common && medianInitialCap != null && medianInitialCap < 10_000
        : preset === "Upside" ? common && upsideMedian != null && upsideMedian >= 2
        : preset === "Fast start" ? common && medianInitialCap != null && medianInitialCap < 10_000 && profitable! >= 0.5
        : preset === "After bundle" ? common && afterBundleMedian != null && afterBundleMedian < 20_000
        : common && profitable! >= 0.5;
      verdict = matched ? "Снайпить" : "Следить";
      reasons.push(matched ? "All local preset thresholds met on observed evidence."
        : "Some preset thresholds are not met or required premium signals are missing.");
    }
    results[preset] = {
      preset, verdict, reasons, sampleSize: launches.length,
      hit20kRate: hit20k, clean20kRate: clean20k, earlyDevSellRate: earlySaleRate,
      medianUpsideMultiple: upsideMedian, simulationSamples: simulation.length,
      averageSimulationRoiPct: avg, profitableSimulationRate: profitable,
    };
  }
  return {
    creator: args.creator, recentLaunches: recent.length, totalLaunches: launches.length,
    lastLaunchAt, presets: results, warnings,
    note: "Indicative observations and configurable local policies. Missing bundle, sale or timed prices prevent a snipe recommendation. No live Blizz fill guarantees.",
  };
}
