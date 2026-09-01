import {
  clamp,
  numberOr,
  toTimestamp,
  type ChainAnalysis,
  type DerivedSocial,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
import {
  telegramCoverageConfidence,
  telegramTokenIntelligence,
} from "./telegram-intelligence-view";

export type IndependenceLayer = {
  source: "x" | "telegram" | "chain";
  available: boolean;
  actors: number;
  independentActors: number;
  independenceScore: number | null;
  coverageConfidence: number | null;
  note: string;
};

export type SourceIndependence = {
  score: number | null;
  concentrationRisk: number | null;
  independentLayers: number;
  availableLayers: number;
  confirmationQuality: number | null;
  verdict: "strong" | "mixed" | "concentrated" | "insufficient";
  layers: IndependenceLayer[];
};

export type ChronologyStageKey =
  | "smart_wallet"
  | "telegram_caller"
  | "x_acceleration"
  | "market_breakout";

export type ChronologyStage = {
  key: ChronologyStageKey;
  label: string;
  timestamp: number | null;
  confidence: number;
  observed: boolean;
  note: string;
};

export type CrossSourceChronology = {
  stages: ChronologyStage[];
  observedStages: number;
  orderableStages: number;
  coverage: number;
  alignmentScore: number | null;
  walletToTelegramMinutes: number | null;
  telegramToXMinutes: number | null;
  xToMarketMinutes: number | null;
  priceLedSocial: boolean;
  summary: string;
};

export type CrossSourceIntelligence = {
  independence: SourceIndependence;
  chronology: CrossSourceChronology;
};

type Args = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  chain: ChainAnalysis | null;
  market: Market | null;
  derived: DerivedSocial;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedRatio(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function xLayer(x: TwitterStats | null): IndependenceLayer {
  if (!x) {
    return {
      source: "x",
      available: false,
      actors: 0,
      independentActors: 0,
      independenceScore: null,
      coverageConfidence: null,
      note: "X coverage отсутствует.",
    };
  }
  const actors = Math.max(
    0,
    Number(x.riskUniverse?.uniqueAuthors ?? x.uniqueMentioners ?? x.shillers?.length ?? 0),
  );
  const botRatioRaw = finite(x.riskUniverse?.botRatio ?? x.aggregated?.botRatio);
  const botRatio = botRatioRaw == null
    ? boundedRatio(x.shillers?.filter((row) => row.isBot).length || 0, Math.max(1, x.shillers?.length || actors))
    : Math.max(0, Math.min(1, botRatioRaw > 1 ? botRatioRaw / 100 : botRatioRaw));
  const independentActors = Math.max(0, Math.round(actors * (1 - botRatio)));
  const botRisk = finite(x.riskUniverse?.botRiskScore ?? x.botRiskScore);
  const independenceScore = actors > 0
    ? clamp((1 - botRatio) * 70 + (100 - (botRisk ?? botRatio * 100)) * 0.30)
    : null;
  const coverageConfidence = actors > 0
    ? clamp(35 + Math.min(45, Math.log10(Math.max(1, actors)) * 28) + (x.meta?.truncated ? -12 : 8))
    : 20;
  return {
    source: "x",
    available: actors > 0,
    actors,
    independentActors,
    independenceScore,
    coverageConfidence,
    note: `${independentActors}/${actors} авторов оценены как независимая часть выборки; bot risk учитывается как штраф, а не как доказательство координации.`,
  };
}

function telegramLayer(tg: SocialTimeline | null): IndependenceLayer {
  const intelligence = telegramTokenIntelligence(tg);
  const coordination = intelligence?.coordination;
  const coverage = telegramCoverageConfidence(tg);
  if (!tg || !coordination || coordination.sources <= 0) {
    return {
      source: "telegram",
      available: false,
      actors: 0,
      independentActors: 0,
      independenceScore: null,
      coverageConfidence: coverage,
      note: "Нет достаточного Telegram evidence для оценки независимости каналов.",
    };
  }
  return {
    source: "telegram",
    available: true,
    actors: coordination.sources,
    independentActors: coordination.independentSources,
    independenceScore: coordination.sourceIndependenceScore,
    coverageConfidence: coverage,
    note: `${coordination.independentSources}/${coordination.sources} источников остаются независимыми после forwarded/text-similarity/timing clustering.`,
  };
}

function chainLayer(chain: ChainAnalysis | null): IndependenceLayer {
  const wallets = chain?.wallets || [];
  if (!wallets.length) {
    return {
      source: "chain",
      available: false,
      actors: 0,
      independentActors: 0,
      independenceScore: null,
      coverageConfidence: null,
      note: "Нет классифицированных on-chain кошельков.",
    };
  }

  const active = wallets.filter((row) => numberOr(row.buys) + numberOr(row.sells) > 0);
  const universe = active.length || wallets.length;
  const wash = active.filter((row) => row.isWashTrader === true).length;
  const unbundled = active.filter((row) => row.isWashTrader !== true && row.bundleId == null).length;
  const bundleClusters = new Set(
    active
      .filter((row) => row.isWashTrader !== true && row.bundleId != null)
      .map((row) => String(row.bundleId)),
  ).size;
  const independentActors = Math.max(0, unbundled + bundleClusters);
  const rawIndependence = boundedRatio(independentActors, Math.max(1, universe)) * 100;
  const washPenalty = boundedRatio(wash, Math.max(1, universe)) * 30;
  const independenceScore = clamp(rawIndependence - washPenalty);
  const coverageConfidence = clamp(
    42
      + Math.min(38, Math.log10(Math.max(1, universe)) * 24)
      + (chain?.truncated || chain?.summary?.historyTruncated ? -18 : 12),
  );
  return {
    source: "chain",
    available: universe > 0,
    actors: universe,
    independentActors,
    independenceScore,
    coverageConfidence,
    note: `${independentActors}/${universe} independent demand units after collapsing bundle clusters and excluding wash-tagged wallets.`,
  };
}

function weightedLayerScore(layers: IndependenceLayer[], key: "independenceScore" | "coverageConfidence") {
  let numerator = 0;
  let denominator = 0;
  for (const layer of layers) {
    const value = layer[key];
    if (!layer.available || value == null) continue;
    const weight = key === "independenceScore"
      ? Math.max(0.25, (layer.coverageConfidence ?? 50) / 100)
      : 1;
    numerator += value * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}

export function buildSourceIndependence(args: Args): SourceIndependence {
  const layers = [xLayer(args.x), telegramLayer(args.telegram), chainLayer(args.chain)];
  const available = layers.filter((layer) => layer.available);
  const score = weightedLayerScore(layers, "independenceScore");
  const coverage = weightedLayerScore(layers, "coverageConfidence");
  const independentLayers = available.filter(
    (layer) => (layer.independenceScore ?? 0) >= 55 && (layer.coverageConfidence ?? 0) >= 35,
  ).length;
  const singleLayerPenalty = available.length <= 1 ? 35 : available.length === 2 ? 12 : 0;
  const weakest = available.length
    ? Math.min(...available.map((layer) => layer.independenceScore ?? 0))
    : 0;
  const concentrationRisk = score == null
    ? null
    : clamp(100 - score + singleLayerPenalty + (weakest < 35 ? 10 : 0));
  const confirmationQuality = score == null || coverage == null
    ? null
    : clamp(score * 0.68 + coverage * 0.32 - singleLayerPenalty * 0.35);
  const verdict: SourceIndependence["verdict"] = available.length < 2 || score == null
    ? "insufficient"
    : independentLayers >= 2 && score >= 70 && (concentrationRisk ?? 100) < 45
      ? "strong"
      : (concentrationRisk ?? 0) >= 65 || score < 45
        ? "concentrated"
        : "mixed";
  return {
    score: score == null ? null : Number(score.toFixed(1)),
    concentrationRisk: concentrationRisk == null ? null : Number(concentrationRisk.toFixed(1)),
    independentLayers,
    availableLayers: available.length,
    confirmationQuality: confirmationQuality == null ? null : Number(confirmationQuality.toFixed(1)),
    verdict,
    layers,
  };
}

function smartWalletTime(chain: ChainAnalysis | null) {
  const values = (chain?.wallets || [])
    .filter(
      (wallet) => wallet.smartClassificationAvailable
        && wallet.isSmart === true
        && numberOr(wallet.buys) > numberOr(wallet.sells),
    )
    .map((wallet) => toTimestamp(wallet.firstSeenOnToken))
    .filter((value): value is number => value != null);
  return values.length ? Math.min(...values) : null;
}

function telegramCallerTime(tg: SocialTimeline | null) {
  const intelligence = telegramTokenIntelligence(tg);
  const explicit = toTimestamp(intelligence?.firstCall?.calledAt);
  if (explicit != null) return { time: explicit, explicit: true };
  const values: number[] = [];
  for (const row of tg?.timeline || []) {
    if (row.platform && row.platform.toLowerCase() !== "telegram") continue;
    const metrics = row.metrics || {};
    const eventType = String(row.event_type || "").toLowerCase();
    const isCall = eventType.includes("call") || metrics.explicit_call === true || metrics.is_explicit_call === true;
    if (!isCall) continue;
    const time = toTimestamp(row.occurred_at);
    if (time != null) values.push(time);
  }
  if (values.length) return { time: Math.min(...values), explicit: true };
  for (const row of tg?.timeline || []) {
    if (row.platform && row.platform.toLowerCase() !== "telegram") continue;
    const time = toTimestamp(row.occurred_at);
    if (time != null) values.push(time);
  }
  return { time: values.length ? Math.min(...values) : null, explicit: false };
}

function xAccelerationTime(x: TwitterStats | null) {
  const rows = (x?.topTweets || [])
    .map((tweet) => ({ time: toTimestamp(tweet.timestamp), author: String(tweet.author || "unknown") }))
    .filter((row): row is { time: number; author: string } => row.time != null)
    .sort((left, right) => left.time - right.time);
  if (!rows.length) return { time: null, strength: 0, burstAuthors: 0 };

  for (let right = 0; right < rows.length; right += 1) {
    const windowStart = rows[right].time - 15 * 60_000;
    const authors = new Set(
      rows.slice(0, right + 1).filter((row) => row.time >= windowStart).map((row) => row.author.toLowerCase()),
    );
    if (authors.size >= 3) return { time: rows[right].time, strength: 1, burstAuthors: authors.size };
  }
  for (let right = 0; right < rows.length; right += 1) {
    const windowStart = rows[right].time - 15 * 60_000;
    const authors = new Set(
      rows.slice(0, right + 1).filter((row) => row.time >= windowStart).map((row) => row.author.toLowerCase()),
    );
    if (authors.size >= 2) return { time: rows[right].time, strength: 0.65, burstAuthors: authors.size };
  }
  return { time: rows[0].time, strength: 0.35, burstAuthors: 1 };
}

function marketBreakout(args: Args) {
  const volumeH1 = finite(args.market?.pair?.volumeH1);
  const volumeH24 = finite(args.market?.pair?.volumeH24);
  const changeH1 = finite(args.market?.pair?.changeH1);
  const hourlyBaseline = volumeH24 != null && volumeH24 > 0 ? volumeH24 / 24 : null;
  const velocity = volumeH1 != null && hourlyBaseline != null && hourlyBaseline > 0
    ? volumeH1 / hourlyBaseline
    : null;
  const impulseTime = toTimestamp(args.derived.price.impulseTime);
  const impulseChange = finite(args.derived.price.impulseChange);
  const breakout = (velocity != null && velocity >= 1.8 && (changeH1 ?? 0) > 0)
    || (impulseChange != null && impulseChange >= 10);
  return {
    time: breakout ? impulseTime : null,
    velocity,
    impulseChange,
    observed: breakout,
  };
}

function minutesBetween(left: number | null, right: number | null) {
  if (left == null || right == null) return null;
  return Number(((right - left) / 60_000).toFixed(2));
}

export function buildCrossSourceChronology(args: Args): CrossSourceChronology {
  const smartTime = smartWalletTime(args.chain);
  const tg = telegramCallerTime(args.telegram);
  const x = xAccelerationTime(args.x);
  const market = marketBreakout(args);
  const stages: ChronologyStage[] = [
    {
      key: "smart_wallet",
      label: "Smart-wallet demand",
      timestamp: smartTime,
      confidence: smartTime == null ? 0 : 0.78,
      observed: smartTime != null,
      note: smartTime == null
        ? "Нет timestamp подтверждённого smart buyer."
        : "Первый timestamp smart-classified buyer с buy bias.",
    },
    {
      key: "telegram_caller",
      label: "Telegram caller",
      timestamp: tg.time,
      confidence: tg.time == null ? 0 : tg.explicit ? 0.92 : 0.55,
      observed: tg.time != null,
      note: tg.time == null
        ? "Telegram timestamp отсутствует."
        : tg.explicit
          ? "Первый explicit Telegram call."
          : "Есть только первое Telegram mention; explicit call не подтверждён.",
    },
    {
      key: "x_acceleration",
      label: "X acceleration",
      timestamp: x.time,
      confidence: x.time == null ? 0 : x.strength,
      observed: x.time != null,
      note: x.time == null
        ? "X timestamps отсутствуют."
        : x.burstAuthors >= 2
          ? `${x.burstAuthors} уникальных X-автора в 15-минутном burst window.`
          : "Есть X activity, но acceleration по нескольким авторам не подтверждён.",
    },
    {
      key: "market_breakout",
      label: "Market breakout",
      timestamp: market.time,
      confidence: market.observed ? (market.velocity != null && market.velocity >= 1.8 ? 0.78 : 0.62) : 0,
      observed: market.observed,
      note: market.observed
        ? `Price impulse${market.impulseChange == null ? "" : ` ${market.impulseChange.toFixed(1)}%`}${market.velocity == null ? "" : `; H1 volume velocity ${market.velocity.toFixed(2)}x vs 24h hourly baseline`}. Timestamp uses the observed price-impulse time; current volume velocity has no exact historical breakout timestamp.`
        : "Нет подтверждённого price/volume breakout в доступном snapshot.",
    },
  ];

  const ordered = stages.filter((stage) => stage.timestamp != null) as Array<ChronologyStage & { timestamp: number }>;
  let correctPairs = 0;
  let comparablePairs = 0;
  for (let index = 0; index < stages.length - 1; index += 1) {
    const left = stages[index].timestamp;
    const right = stages[index + 1].timestamp;
    if (left == null || right == null) continue;
    comparablePairs += 1;
    if (left <= right) correctPairs += 1;
  }
  const alignmentScore = comparablePairs
    ? Number(((correctPairs / comparablePairs) * 100).toFixed(1))
    : null;
  const coverage = Number(((ordered.length / stages.length) * 100).toFixed(1));
  const walletToTelegramMinutes = minutesBetween(smartTime, tg.time);
  const telegramToXMinutes = minutesBetween(tg.time, x.time);
  const xToMarketMinutes = minutesBetween(x.time, market.time);
  const socialTimes = [tg.time, x.time].filter((value): value is number => value != null);
  const firstSocial = socialTimes.length ? Math.min(...socialTimes) : null;
  const priceLedSocial = market.time != null && firstSocial != null && market.time < firstSocial;

  const observedLabels = stages
    .filter((stage) => stage.timestamp != null)
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
    .map((stage) => stage.label);
  const summary = observedLabels.length >= 2
    ? `${observedLabels.join(" → ")}. Chronology coverage ${Math.round(coverage)}%${alignmentScore == null ? "" : `; canonical-order alignment ${Math.round(alignmentScore)}%`}.`
    : "Недостаточно timestamp-источников для устойчивой cross-source chronology.";

  return {
    stages,
    observedStages: stages.filter((stage) => stage.observed).length,
    orderableStages: ordered.length,
    coverage,
    alignmentScore,
    walletToTelegramMinutes,
    telegramToXMinutes,
    xToMarketMinutes,
    priceLedSocial,
    summary,
  };
}

export function buildCrossSourceIntelligence(args: Args): CrossSourceIntelligence {
  return {
    independence: buildSourceIndependence(args),
    chronology: buildCrossSourceChronology(args),
  };
}

export function crossSourceSnapshotFeatures(args: Args, observedAt: string) {
  const intelligence = buildCrossSourceIntelligence(args);
  const { independence, chronology } = intelligence;
  const rows: Array<{
    key: string;
    group: string;
    label: string;
    value: string | number | null;
    numericValue: number | null;
    source: "derived";
    confidence: number;
    observedAt: string;
    missing: boolean;
    note: string;
  }> = [];

  const add = (
    key: string,
    group: string,
    label: string,
    value: string | number | null,
    numericValue: number | null,
    confidence: number,
    note: string,
  ) => rows.push({
    key,
    group,
    label,
    value,
    numericValue,
    source: "derived",
    confidence: value == null ? 0 : confidence,
    observedAt,
    missing: value == null,
    note,
  });

  add("cross_source.independence_score", "Cross-source Independence", "Independence score", independence.score, independence.score, 0.76, "Coverage-weighted deterministic independence across X, Telegram and on-chain actors.");
  add("cross_source.independent_layers", "Cross-source Independence", "Independent layers", independence.availableLayers ? independence.independentLayers : null, independence.availableLayers ? independence.independentLayers : null, 0.82, "Count of source layers with both usable coverage and >=55 independence.");
  add("cross_source.concentration_risk", "Cross-source Independence", "Concentration risk", independence.concentrationRisk, independence.concentrationRisk, 0.74, "Higher means visible confirmation depends on fewer/non-independent source layers.");
  add("cross_source.confirmation_quality", "Cross-source Independence", "Confirmation quality", independence.confirmationQuality, independence.confirmationQuality, 0.72, "Combines source independence with source coverage; not a probability of price appreciation.");
  for (const layer of independence.layers) {
    add(`cross_source.${layer.source}_independence`, "Cross-source Independence", `${layer.source.toUpperCase()} independence`, layer.independenceScore, layer.independenceScore, 0.72, layer.note);
  }

  add("cross_source.chronology_coverage", "Cross-source Chronology", "Chronology coverage", chronology.coverage, chronology.coverage, 0.78, "Percent of canonical smart-wallet -> Telegram -> X -> market stages observed.");
  add("cross_source.chronology_alignment", "Cross-source Chronology", "Chronology alignment", chronology.alignmentScore, chronology.alignmentScore, 0.68, "Share of comparable adjacent canonical stages observed in the expected temporal order.");
  add("cross_source.wallet_to_telegram_minutes", "Cross-source Chronology", "Wallet to Telegram lag", chronology.walletToTelegramMinutes, chronology.walletToTelegramMinutes, 0.74, "Positive means smart-wallet demand preceded Telegram; negative means Telegram preceded the classified smart-wallet timestamp.");
  add("cross_source.telegram_to_x_minutes", "Cross-source Chronology", "Telegram to X lag", chronology.telegramToXMinutes, chronology.telegramToXMinutes, 0.74, "Positive means Telegram preceded the X acceleration/activity timestamp.");
  add("cross_source.x_to_market_minutes", "Cross-source Chronology", "X to market lag", chronology.xToMarketMinutes, chronology.xToMarketMinutes, 0.62, "Positive means X preceded the observed price-impulse timestamp. Volume velocity is current-state context, not an exact historical breakout timestamp.");
  add("cross_source.price_led_social", "Cross-source Chronology", "Price led social", chronology.orderableStages >= 2 ? (chronology.priceLedSocial ? 1 : 0) : null, chronology.orderableStages >= 2 ? (chronology.priceLedSocial ? 1 : 0) : null, 0.70, "1 only when an observed market impulse timestamp precedes the first observed X/Telegram timestamp.");

  return rows;
}
