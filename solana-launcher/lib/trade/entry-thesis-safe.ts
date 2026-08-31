import {
  buildEntryThesis,
  type EntryAction,
  type EntryThesis,
} from "./entry-thesis";
import {
  clamp,
  type AiEnvelope,
  type ChainAnalysis,
  type DerivedSocial,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
import type { LiveIntelligenceModel } from "./live-intelligence";
import type { SourceNarratives } from "./source-narrative";
import {
  buildCrossSourceChronology,
  buildSourceIndependence,
} from "./cross-source-intelligence-safe";
import {
  hasChainIntelligence,
  hasEarlyTimingEvidence,
  hasFreshMarket,
  hasTelegramIntelligence,
  hasXIntelligence,
} from "./intelligence-coverage";

type BuildArgs = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  market: Market | null;
  chain: ChainAnalysis | null;
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  model: LiveIntelligenceModel;
  narratives: SourceNarratives;
};

function rank(action: EntryAction) {
  return {
    strong_entry: 5,
    consider: 4,
    wait_confirmation: 3,
    late_weak: 2,
    avoid: 1,
  }[action];
}

function label(action: EntryAction) {
  if (action === "strong_entry") return "Сильный вход";
  if (action === "consider") return "Можно рассматривать";
  if (action === "wait_confirmation") return "Ждать подтверждения";
  if (action === "late_weak") return "Поздний / слабый вход";
  return "Избегать входа";
}

function unique(rows: string[]) {
  return [...new Set(rows.filter(Boolean))];
}

function derivedForMissingCoverage(
  derived: DerivedSocial,
  hasSocial: boolean,
  earlyKnown: boolean,
): DerivedSocial {
  if (!hasSocial) {
    return {
      ...derived,
      xScore: 0,
      tgScore: 0,
      organic: 50,
      manipulation: 0,
      socialRisk: 50,
      early: 50,
      alpha: 50,
      socialScore: 50,
    };
  }
  if (earlyKnown) return derived;

  const observedTimingNeutral = clamp(
    (derived.socialScore * 0.38 + derived.alpha * 0.22 + derived.organic * 0.20) / 0.80,
  );
  return { ...derived, early: observedTimingNeutral };
}

function removeFalseEarlyClaims(rows: string[]) {
  return rows.filter((row) => {
    const value = row.toLowerCase();
    return !value.includes("early score")
      && !value.includes("сигнал остаётся относительно ранним")
      && !value.includes("социальный сигнал выглядит запоздалым");
  });
}

function downgradedThesis(action: EntryAction) {
  if (action === "consider") {
    return "Сигнал можно рассматривать, но текущий момент не подтверждает безусловно сильный вход: часть движения уже могла начаться до social-подтверждения или качество независимых источников недостаточно высокое.";
  }
  if (action === "wait_confirmation") {
    return "У токена есть наблюдаемое подтверждение, но качество текущего входа ограничено независимостью источников, chronology или свежестью данных. Нужен новый независимый факт, прежде чем повышать статус входа.";
  }
  if (action === "late_weak") {
    return "Сигнал присутствует, но текущая точка выглядит поздней или слабой относительно уже произошедшего движения; дополнительный social-шум сам по себе не улучшает вход.";
  }
  if (action === "avoid") {
    return "Текущая совокупность риска, структуры источников и цены не поддерживает вход; для пересмотра нужен существенный новый независимый evidence.";
  }
  return "Текущий вход подтверждается несколькими независимыми факторами при достаточной свежести данных.";
}

export function buildCoverageAwareEntryThesis(args: BuildArgs): EntryThesis {
  const xAvailable = hasXIntelligence(args.x);
  const tgAvailable = hasTelegramIntelligence(args.telegram);
  const chainAvailable = hasChainIntelligence(args.chain);
  const marketFresh = hasFreshMarket(args.market);
  const earlyKnown = hasEarlyTimingEvidence(
    xAvailable ? args.x : null,
    tgAvailable ? args.telegram : null,
    args.market,
  );
  const hasSocial = xAvailable || tgAvailable;
  const crossSourceArgs = {
    x: xAvailable ? args.x : null,
    telegram: tgAvailable ? args.telegram : null,
    chain: chainAvailable ? args.chain : null,
    market: marketFresh ? args.market : null,
    derived: args.derived,
  };
  const independence = buildSourceIndependence(crossSourceArgs);
  const chronology = buildCrossSourceChronology(crossSourceArgs);

  const base = buildEntryThesis({
    market: marketFresh ? args.market : null,
    chain: chainAvailable ? args.chain : null,
    derived: derivedForMissingCoverage(args.derived, hasSocial, earlyKnown),
    ai: args.ai,
    model: args.model,
    narratives: args.narratives,
  });

  let action = base.action;
  let priceState = base.priceState;
  let priceExplanation = base.priceExplanation;
  let thesis = base.thesis;
  let whyNow = [...base.whyNow];
  let alreadyPricedIn = [...base.alreadyPricedIn];
  let confirmationNeeded = [...base.confirmationNeeded];
  const invalidation = [...base.invalidation];
  let confidence = base.confidence;

  if (!earlyKnown) {
    whyNow = removeFalseEarlyClaims(whyNow);
    alreadyPricedIn = removeFalseEarlyClaims(alreadyPricedIn);
    confirmationNeeded = removeFalseEarlyClaims(confirmationNeeded);
    confirmationNeeded.push(
      "Early timing не подтверждён timestamp-данными; неизвестное время сигнала не считается ни ранним, ни поздним.",
    );
  }

  if (!marketFresh) {
    priceState = "unknown";
    if (rank(action) > rank("wait_confirmation")) action = "wait_confirmation";
    const stale = Boolean(args.market?.pair && args.market.meta?.stale === true);
    priceExplanation = stale
      ? "Market snapshot устарел и исключён из оценки текущей цены. Пока не придёт свежий снимок, система не называет вход дорогим, дешёвым, перегретым или стабильным только по старым 1ч/24ч данным."
      : "Свежих market/price данных нет, поэтому система не делает вид, что знает качество текущей цены. Сила токена и структура источников оцениваются отдельно от текущего entry timing.";
    thesis = action === "avoid"
      ? base.thesis
      : "Сила токена может оставаться интересной, но текущий момент входа нельзя подтвердить без свежей цены и ликвидности. Поэтому статус ограничен ожиданием подтверждения, а не догадкой по устаревшему рынку.";
    confirmationNeeded.push(
      stale
        ? "Нужен свежий market refresh: stale 1ч/24ч движение и ликвидность не используются для current-entry вывода."
        : "Нужны свежие market/price данные для оценки текущего момента входа.",
    );
    confidence = clamp(confidence - (stale ? 8 : 4));
  }

  const concentrationRisk = independence.concentrationRisk;
  if (
    independence.availableLayers >= 2
    && concentrationRisk != null
    && concentrationRisk >= 65
  ) {
    if (rank(action) > rank("wait_confirmation")) action = "wait_confirmation";
    confirmationNeeded.push(
      `Source concentration risk ${Math.round(concentrationRisk)}/100: нужен новый независимый слой подтверждения, а не дополнительный репост/связанный кластер.`,
    );
    confidence = clamp(confidence - Math.min(16, (concentrationRisk - 55) * 0.35));
    if (concentrationRisk >= 82 && independence.independentLayers <= 1) {
      alreadyPricedIn.push(
        "Видимая активность концентрируется в одном независимом слое; количество сообщений/кошельков может переоценивать реальную ширину спроса.",
      );
    }
  } else if (
    independence.verdict === "strong"
    && independence.confirmationQuality != null
    && independence.confirmationQuality >= 68
  ) {
    whyNow.push(
      `Подтверждение распределено между ${independence.independentLayers} независимыми слоями; confirmation quality ${Math.round(independence.confirmationQuality)}/100.`,
    );
  }

  if (chronology.priceLedSocial) {
    if (action === "strong_entry") action = "consider";
    alreadyPricedIn.push(
      "Наблюдаемый market impulse появился раньше доступного X/Telegram evidence; часть social-активности может быть реакцией на уже начавшееся движение.",
    );
    confirmationNeeded.push(
      "Для усиления входного тезиса нужен новый независимый спрос после social-сигнала, а не продолжение уже начавшегося price move.",
    );
    confidence = clamp(confidence - 7);
  }

  if (
    chronology.orderableStages >= 3
    && chronology.alignmentScore != null
    && chronology.alignmentScore < 50
  ) {
    if (rank(action) > rank("wait_confirmation")) action = "wait_confirmation";
    confirmationNeeded.push(
      `Cross-source chronology согласована только на ${Math.round(chronology.alignmentScore)}%: ранний сценарий smart wallet → TG → X → market пока не подтверждён.`,
    );
    confidence = clamp(confidence - 6);
  } else if (
    chronology.orderableStages >= 3
    && chronology.alignmentScore != null
    && chronology.alignmentScore >= 67
    && chronology.coverage >= 75
  ) {
    whyNow.push(
      `Chronology подтверждена на ${Math.round(chronology.alignmentScore)}% при coverage ${Math.round(chronology.coverage)}%: доступные стадии идут в последовательности, совместимой с ранним распространением сигнала.`,
    );
  }

  if (!chainAvailable) {
    confirmationNeeded.push(
      "Нужно реальное on-chain покрытие: пустой blockchain-объект не считается нейтральным подтверждением.",
    );
  }
  if (!hasSocial) {
    confirmationNeeded.push(
      "Нет пригодного X/Telegram покрытия; пустые social-источники исключены из поддержки и риска вместо оценки 0/100.",
    );
  }
  if (independence.availableLayers < 2) {
    confirmationNeeded.push(
      "Source Independence пока не подтверждена минимум двумя доступными слоями; один источник не считается cross-source подтверждением.",
    );
  }

  if (action !== base.action && thesis === base.thesis) {
    thesis = downgradedThesis(action);
  }

  return {
    ...base,
    priceState,
    action,
    actionLabel: label(action),
    headline: `${label(action)} · ${priceState === "unknown" ? "текущая цена не подтверждена свежими данными" : base.headline.split(" · ").slice(1).join(" · ") || base.headline}`,
    thesis,
    priceExplanation,
    whyNow: unique(whyNow).slice(0, 8),
    alreadyPricedIn: unique(alreadyPricedIn).slice(0, 8),
    confirmationNeeded: unique(confirmationNeeded).slice(0, 9),
    invalidation: unique(invalidation).slice(0, 8),
    confidence,
  };
}
