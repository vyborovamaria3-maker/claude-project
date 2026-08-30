import {
  clamp,
  numberOr,
  type AiEnvelope,
  type ChainAnalysis,
  type DerivedSocial,
  type Market,
} from "./social-intelligence";
import type { LiveIntelligenceModel } from "./live-intelligence";
import type { SourceNarratives } from "./source-narrative";

export type EntryPriceState =
  | "discounted_vs_signal"
  | "reasonable_vs_signal"
  | "stretched_vs_signal"
  | "overheated_vs_signal"
  | "unstable_vs_signal"
  | "unknown";

export type EntryAction =
  | "strong_entry"
  | "consider"
  | "wait_confirmation"
  | "late_weak"
  | "avoid";

export type EntryThesis = {
  priceState: EntryPriceState;
  action: EntryAction;
  actionLabel: string;
  headline: string;
  thesis: string;
  priceExplanation: string;
  whyNow: string[];
  alreadyPricedIn: string[];
  confirmationNeeded: string[];
  invalidation: string[];
  qwenView: string | null;
  qwenAgreement: "agree" | "disagree" | "partial" | "unavailable";
  deterministicEntryScore: number;
  overextensionScore: number;
  evidenceSupportScore: number;
  confidence: number;
};

type BuildEntryThesisArgs = {
  market: Market | null;
  chain: ChainAnalysis | null;
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  model: LiveIntelligenceModel;
  narratives: SourceNarratives;
};

type QwenEntryAssessment = {
  priceState?: "discounted_vs_signal" | "reasonable_vs_signal" | "stretched_vs_signal" | "overheated_vs_signal" | "unstable_vs_signal" | "unknown";
  entryAction?: "strong_entry" | "consider" | "wait_confirmation" | "late_weak" | "avoid";
  oneLineVerdict?: string;
  whyNow?: string[];
  alreadyPricedIn?: string[];
  missingConfirmation?: string[];
  invalidation?: string[];
  confidence?: number;
};

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(value: number | null, digits = 1) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function money(value: number | null) {
  if (value == null) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function unique(rows: Array<string | null | undefined>) {
  return [...new Set(rows.filter((row): row is string => Boolean(row?.trim())).map((row) => row.trim()))];
}

function severityRank(action: EntryAction) {
  return {
    strong_entry: 5,
    consider: 4,
    wait_confirmation: 3,
    late_weak: 2,
    avoid: 1,
  }[action];
}

function actionFromScore(score: number): EntryAction {
  if (score >= 78) return "strong_entry";
  if (score >= 64) return "consider";
  if (score >= 50) return "wait_confirmation";
  if (score >= 35) return "late_weak";
  return "avoid";
}

function actionLabel(action: EntryAction) {
  if (action === "strong_entry") return "Сильный вход";
  if (action === "consider") return "Можно рассматривать";
  if (action === "wait_confirmation") return "Ждать подтверждения";
  if (action === "late_weak") return "Поздний / слабый вход";
  return "Избегать входа";
}

function priceStateLabel(state: EntryPriceState) {
  if (state === "discounted_vs_signal") return "цена пока не догнала качество сигнала";
  if (state === "reasonable_vs_signal") return "цена выглядит нормальной относительно подтверждений";
  if (state === "stretched_vs_signal") return "цена уже растянута относительно подтверждений";
  if (state === "overheated_vs_signal") return "цена перегрета относительно текущих подтверждений";
  if (state === "unstable_vs_signal") return "цена нестабильна — падение ещё не стало качественной скидкой";
  return "недостаточно данных для оценки цены относительно сигнала";
}

function qwenEntry(ai: AiEnvelope | null): QwenEntryAssessment | null {
  if (!ai || ai.available === false || !ai.result) return null;
  const result = ai.result as typeof ai.result & { entryAssessment?: QwenEntryAssessment };
  return result.entryAssessment || null;
}

function qwenFallbackView(ai: AiEnvelope | null) {
  const result = ai?.available === false ? null : ai?.result;
  if (!result) return null;
  const final = (result as typeof result & {
    finalIntelligence?: {
      marketState?: string;
      bullCase?: string;
      bearCase?: string;
      confidence?: number;
    };
  }).finalIntelligence;
  const reasoning = Array.isArray(result.reasoningSummary) ? result.reasoningSummary.filter(Boolean).slice(0, 2) : [];
  return unique([
    final?.marketState,
    final?.bullCase ? `Bull case: ${final.bullCase}` : null,
    final?.bearCase ? `Bear case: ${final.bearCase}` : null,
    ...reasoning,
  ]).join(" ") || null;
}

function buildChainEvidence(chain: ChainAnalysis | null) {
  const wallets = chain?.wallets || [];
  const smart = wallets.filter((wallet) => wallet.smartClassificationAvailable && wallet.isSmart === true);
  const smartBuyers = smart.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells)).length;
  const smartSellers = smart.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys)).length;
  const buyers = wallets.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells)).length;
  const sellers = wallets.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys)).length;
  const wash = wallets.filter((wallet) => wallet.isWashTrader === true).length;
  const fresh = wallets.filter((wallet) => wallet.freshnessVerified && wallet.isFresh === true).length;
  const bundleWallets = (chain?.bundles || []).reduce((sum, bundle) => sum + numberOr(bundle.size), 0);
  const directional = buyers + sellers;
  const buyerShare = directional ? (buyers / directional) * 100 : 50;
  const washShare = wallets.length ? (wash / wallets.length) * 100 : 0;
  const bundleShare = wallets.length ? clamp((bundleWallets / wallets.length) * 100) : 0;
  return {
    wallets: wallets.length,
    smartBuyers,
    smartSellers,
    buyers,
    sellers,
    fresh,
    wash,
    buyerShare,
    washShare,
    bundleShare,
  };
}

function sourceToneScore(tone: "positive" | "mixed" | "negative" | "unknown") {
  if (tone === "positive") return 78;
  if (tone === "mixed") return 52;
  if (tone === "negative") return 24;
  return null;
}

export function buildEntryThesis(args: BuildEntryThesisArgs): EntryThesis {
  const { market, chain, derived, ai, model, narratives } = args;
  const h1 = finite(market?.pair?.changeH1);
  const h24 = finite(market?.pair?.change24h);
  const liquidity = finite(market?.pair?.liquidityUsd);
  const chainEvidence = buildChainEvidence(chain);

  const runup1h = h1 == null ? 0 : Math.max(0, h1 - 10);
  const runup24h = h24 == null ? 0 : Math.max(0, h24 - 35);
  const dump1h = h1 == null ? 0 : Math.max(0, -h1 - 8);
  const dump24h = h24 == null ? 0 : Math.max(0, -h24 - 25);
  const dumpPenalty = clamp(dump1h * 1.25 + dump24h * 0.35, 0, 35);
  const liquidityPenalty = liquidity == null
    ? 4
    : liquidity < 15_000
      ? 20
      : liquidity < 35_000
        ? 12
        : liquidity < 75_000
          ? 6
          : 0;
  const impulse = finite(derived.price.impulseChange);
  const impulseExcess = impulse == null ? 0 : Math.max(0, impulse - 12);
  const overextensionScore = clamp(
    runup1h * 2.1
      + runup24h * 0.55
      + impulseExcess * 1.2
      + Math.max(0, derived.manipulation - 55) * 0.38,
  );

  const chainSupport = chain
    ? clamp(
        50
          + (chainEvidence.smartBuyers - chainEvidence.smartSellers) * 9
          + (chainEvidence.buyerShare - 50) * 0.55
          + Math.min(10, chainEvidence.fresh * 1.2)
          - chainEvidence.washShare * 0.75
          - chainEvidence.bundleShare * 0.2,
      )
    : null;

  const sourceScores = [
    sourceToneScore(narratives.x.tone),
    sourceToneScore(narratives.telegram.tone),
    sourceToneScore(narratives.chain.tone),
  ].filter((value): value is number => value != null);
  const sourceSupport = sourceScores.length
    ? sourceScores.reduce((sum, value) => sum + value, 0) / sourceScores.length
    : null;

  const socialSupport = clamp(
    derived.socialScore * 0.38
      + derived.alpha * 0.22
      + derived.organic * 0.2
      + derived.early * 0.2
      - Math.max(0, derived.manipulation - 50) * 0.35,
  );

  const evidenceSupportScore = clamp(
    model.tokenStrength * 0.28
      + model.entryScore * 0.24
      + socialSupport * 0.18
      + (chainSupport ?? 50) * 0.2
      + (sourceSupport ?? 50) * 0.1,
  );

  const sellerPenalty = chain
    ? Math.max(0, chainEvidence.smartSellers - chainEvidence.smartBuyers) * 5
      + Math.max(0, 50 - chainEvidence.buyerShare) * 0.3
    : 0;
  const riskPenalty = Math.max(0, model.riskScore - 50) * 0.35;
  const stabilityPenalty = Math.max(0, 55 - model.stability) * 0.28;
  const adjustedEntry = clamp(
    model.entryScore
      + Math.max(-8, Math.min(8, (evidenceSupportScore - 50) * 0.12))
      - overextensionScore * 0.22
      - dumpPenalty
      - liquidityPenalty
      - sellerPenalty
      - riskPenalty
      - stabilityPenalty,
  );

  const severeDump = (h1 != null && h1 <= -15) || (h24 != null && h24 <= -40);
  const moderateDump = (h1 != null && h1 <= -8) || (h24 != null && h24 <= -25);
  let priceState: EntryPriceState;
  if (!market?.pair && impulse == null) {
    priceState = "unknown";
  } else if (severeDump) {
    priceState = "unstable_vs_signal";
  } else if (overextensionScore >= 62 || ((h1 ?? 0) >= 25 && evidenceSupportScore < 72)) {
    priceState = "overheated_vs_signal";
  } else if (overextensionScore >= 32 || ((h1 ?? 0) >= 14 && evidenceSupportScore < 70)) {
    priceState = "stretched_vs_signal";
  } else if (
    h1 != null
    && h1 >= -6
    && h1 <= 4
    && (h24 == null || h24 >= -20)
    && evidenceSupportScore >= 72
    && model.riskScore < 55
    && (liquidity == null || liquidity >= 35_000)
  ) {
    priceState = "discounted_vs_signal";
  } else {
    priceState = "reasonable_vs_signal";
  }

  let action = actionFromScore(adjustedEntry);
  if (priceState === "unstable_vs_signal") {
    action = evidenceSupportScore >= 72 && model.riskScore < 60 ? "wait_confirmation" : "avoid";
  } else if (priceState === "overheated_vs_signal" && severityRank(action) > severityRank("late_weak")) {
    action = model.tokenStrength >= 72 ? "late_weak" : "avoid";
  } else if (priceState === "stretched_vs_signal" && action === "strong_entry") {
    action = "consider";
  }
  if (liquidity != null && liquidity < 15_000 && severityRank(action) > severityRank("wait_confirmation")) {
    action = "wait_confirmation";
  }

  const whyNow: string[] = [];
  const alreadyPricedIn: string[] = [];
  const confirmationNeeded: string[] = [];
  const invalidation: string[] = [];

  if (h1 != null) {
    if (h1 >= 20) {
      alreadyPricedIn.push(`Цена уже выросла на ${pct(h1)} за 1ч — значительная часть краткосрочного импульса может быть уже заложена в цену.`);
    } else if (h1 >= 8) {
      alreadyPricedIn.push(`За 1ч цена уже прошла ${pct(h1)}: вход не ранний, но движение ещё не обязательно перегрето.`);
    } else if (h1 <= -15) {
      invalidation.push(`Цена падает ${pct(h1)} за 1ч. Такое движение нельзя считать скидкой без стабилизации покупателей и on-chain подтверждения.`);
    } else if (h1 <= -8) {
      confirmationNeeded.push(`Цена снизилась на ${pct(h1)} за 1ч: откат потенциально улучшает цену, но сначала нужно увидеть стабилизацию, а не продолжение разгрузки.`);
    } else {
      whyNow.push(`Изменение за 1ч ${pct(h1)} не выглядит экстремальным относительно текущего сигнала.`);
    }
  }
  if (h24 != null && h24 >= 45) alreadyPricedIn.push(`Суточный рост ${pct(h24)} повышает риск позднего входа даже при сильной монете.`);
  if (h24 != null && h24 <= -40) invalidation.push(`Суточное движение ${pct(h24)} указывает на структурную нестабильность цены, а не автоматически на привлекательную скидку.`);
  if (impulse != null && impulse >= 12) alreadyPricedIn.push(`Зафиксирован ценовой импульс ${pct(impulse)} — часть social/on-chain сигнала уже реализовалась в цене.`);

  if (liquidity == null) {
    confirmationNeeded.push("Ликвидность не подтверждена; без неё сложнее оценить качество текущей цены и риск проскальзывания.");
  } else if (liquidity < 15_000) {
    invalidation.push(`Ликвидность всего около ${money(liquidity)} — цена может резко двигаться даже от сравнительно небольших сделок.`);
  } else if (liquidity < 35_000) {
    confirmationNeeded.push(`Ликвидность около ${money(liquidity)} остаётся тонкой; входной сигнал требует более сильного подтверждения потока покупателей.`);
  } else if (liquidity >= 100_000) {
    whyNow.push(`Ликвидность около ${money(liquidity)} снижает риск того, что текущая цена держится только на очень тонком стакане.`);
  }

  if (chainEvidence.smartBuyers > chainEvidence.smartSellers) {
    whyNow.push(`Smart-wallets чаще набирают, чем сокращают позицию (${chainEvidence.smartBuyers} против ${chainEvidence.smartSellers}).`);
  } else if (chainEvidence.smartSellers > chainEvidence.smartBuyers) {
    invalidation.push(`Smart-wallets чаще продают (${chainEvidence.smartSellers} против ${chainEvidence.smartBuyers}); продолжение разгрузки ухудшает тезис.`);
  } else if (chain && chainEvidence.smartBuyers + chainEvidence.smartSellers > 0) {
    confirmationNeeded.push("Нужен явный перевес smart-wallet покупателей над продавцами.");
  }

  if (chain && chainEvidence.buyerShare >= 58) whyNow.push(`Покупатели преобладают среди направленных кошельков: около ${Math.round(chainEvidence.buyerShare)}%.`);
  if (chain && chainEvidence.buyerShare <= 42) invalidation.push(`Продавцы преобладают: покупательская доля лишь около ${Math.round(chainEvidence.buyerShare)}%.`);
  if (chainEvidence.fresh >= 3) whyNow.push(`Есть приток fresh wallets (${chainEvidence.fresh}), что подтверждает появление новых участников.`);
  if (chainEvidence.washShare >= 8) invalidation.push(`Около ${Math.round(chainEvidence.washShare)}% классифицированных кошельков имеют wash-признаки; объём нельзя считать полностью органическим.`);
  if (chainEvidence.bundleShare >= 25) invalidation.push(`Высокая bundle-концентрация (${Math.round(chainEvidence.bundleShare)}% относительно числа кошельков) ослабляет независимость спроса.`);

  if (derived.organic >= 65) whyNow.push(`Социальная органичность высокая: ${Math.round(derived.organic)}/100.`);
  if (derived.manipulation >= 60) invalidation.push(`Manipulation score ${Math.round(derived.manipulation)}/100 — часть внимания может быть искусственно усилена.`);
  if (derived.early >= 65) whyNow.push(`Сигнал остаётся относительно ранним по social/price timing: ${Math.round(derived.early)}/100.`);
  if (derived.early <= 40) alreadyPricedIn.push(`Early score всего ${Math.round(derived.early)}/100 — социальный сигнал выглядит запоздалым относительно движения цены.`);

  if (model.stability < 55) confirmationNeeded.push(`Источники пока недостаточно согласованы (${Math.round(model.stability)}/100); нужен повторный cross-source сигнал.`);
  if (model.confidence < 60) confirmationNeeded.push(`Покрытие данных даёт только ${Math.round(model.confidence)}% уверенности — входной вывод пока хрупкий.`);
  if (!chain) confirmationNeeded.push("Нужно on-chain подтверждение: текущая классификация кошельков недоступна.");
  if (!market?.pair) confirmationNeeded.push("Нужны свежие market-данные, чтобы оценить перегрев цены.");
  if (moderateDump && chainEvidence.smartBuyers <= chainEvidence.smartSellers) {
    confirmationNeeded.push("После снижения цены нужен разворот on-chain потока в пользу покупателей; без этого падение не считается качественным откатом.");
  }

  const deterministicAction = action;
  const qwen = qwenEntry(ai);
  let qwenAgreement: EntryThesis["qwenAgreement"] = "unavailable";
  const qwenView = qwen?.oneLineVerdict?.trim() || qwenFallbackView(ai);

  if (qwen?.entryAction) {
    const distance = Math.abs(severityRank(qwen.entryAction) - severityRank(deterministicAction));
    qwenAgreement = distance === 0 ? "agree" : distance === 1 ? "partial" : "disagree";
    if ((qwen.confidence ?? 0) >= 0.65) {
      if (qwenAgreement === "agree") {
        whyNow.push(...(qwen.whyNow || []).slice(0, 3).map((row) => `Qwen подтверждает: ${row}`));
      } else if (qwenAgreement === "disagree") {
        confirmationNeeded.push(`Qwen расходится с детерминированной оценкой (${actionLabel(qwen.entryAction)} против ${actionLabel(deterministicAction)}); нужен дополнительный факт, а не усреднение мнений.`);
      }
    }
    alreadyPricedIn.push(...(qwen.alreadyPricedIn || []).slice(0, 2).map((row) => `Qwen: ${row}`));
    confirmationNeeded.push(...(qwen.missingConfirmation || []).slice(0, 2).map((row) => `Qwen ждёт: ${row}`));
    invalidation.push(...(qwen.invalidation || []).slice(0, 2).map((row) => `Qwen: ${row}`));
  }

  const priceExplanation = priceState === "overheated_vs_signal"
    ? `По текущей цене вход выглядит дорогим относительно доступных подтверждений: перегрев ${Math.round(overextensionScore)}/100, а подтверждение источниками ${Math.round(evidenceSupportScore)}/100. Сильная монета здесь не равна хорошей цене входа.`
    : priceState === "stretched_vs_signal"
      ? "Цена уже растянута относительно сигнала: часть движения реализована, поэтому качество следующего входа зависит от нового подтверждения или отката, а не только от силы токена."
      : priceState === "unstable_vs_signal"
        ? `Цена сейчас нестабильна${h1 != null ? ` (${pct(h1)} за 1ч)` : ""}. Сильное падение само по себе не делает монету дешёвой: сначала нужно увидеть, что продавцы перестали доминировать и спрос действительно удерживает новый уровень.`
        : priceState === "discounted_vs_signal"
          ? "Цена пока не выглядит догнавшей качество сигнала: подтверждения источников сильнее текущего перегрева. Это улучшает момент входа, если on-chain и social структура не ломается."
          : priceState === "reasonable_vs_signal"
            ? "Текущая цена выглядит приемлемой относительно силы подтверждений: нет явного вертикального перегрева или аварийного падения, но вход всё равно зависит от продолжения cross-source подтверждения."
            : "Без свежих market/price данных нельзя честно сказать, дорогая ли текущая цена относительно сигнала.";

  const thesis = action === "strong_entry"
    ? "Система считает текущий момент сильным для входного тезиса: подтверждение источниками высокое, а цена пока не показывает критического перегрева. Это не гарантия продолжения роста; ключевой риск — быстрое ухудшение on-chain потока."
    : action === "consider"
      ? "Входной тезис сейчас поддержан, но не идеален: есть реальные подтверждения, однако часть движения уже могла быть реализована или остаются риски качества спроса."
      : action === "wait_confirmation"
        ? "Сейчас лучше ждать подтверждения, а не догонять движение или ловить падающую цену: качество монеты может быть нормальным, но цена/источники ещё не дают достаточно чистого момента входа."
        : action === "late_weak"
          ? "Монета может оставаться сильной, но текущий вход выглядит поздним или дорогим относительно доступного сигнала. Нужен откат либо новое независимое подтверждение, чтобы улучшить соотношение риска к моменту."
          : "Текущий входной тезис слабый: риск, нестабильность и/или перегрев перевешивают доступные подтверждения. Пока система не видит достаточного основания считать текущую цену качественным моментом входа.";

  const confidenceBase = model.confidence * 0.45 + model.stability * 0.25 + Math.min(100, evidenceSupportScore) * 0.3;
  const qwenConfidence = qwen?.confidence == null ? null : clamp(qwen.confidence * 100);
  const disagreementPenalty = qwenAgreement === "disagree" ? 14 : qwenAgreement === "partial" ? 5 : 0;
  const dataPenalty = (liquidity == null ? 4 : 0) + (market?.meta?.stale ? 8 : 0);
  const confidence = clamp(
    confidenceBase
      + (qwenAgreement === "agree" && qwenConfidence != null ? Math.min(8, qwenConfidence * 0.08) : 0)
      - disagreementPenalty
      - dataPenalty,
  );

  const headline = `${actionLabel(action)} · ${priceStateLabel(priceState)}`;

  return {
    priceState,
    action,
    actionLabel: actionLabel(action),
    headline,
    thesis,
    priceExplanation,
    whyNow: unique(whyNow).slice(0, 8),
    alreadyPricedIn: unique(alreadyPricedIn).slice(0, 7),
    confirmationNeeded: unique(confirmationNeeded).slice(0, 8),
    invalidation: unique(invalidation).slice(0, 8),
    qwenView,
    qwenAgreement,
    deterministicEntryScore: adjustedEntry,
    overextensionScore,
    evidenceSupportScore,
    confidence,
  };
}
