import {
  clamp,
  numberOr,
  type AiEnvelope,
  type ChainAnalysis,
  type DerivedSocial,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
import {
  buildCrossSourceIntelligence,
  type CrossSourceChronology,
  type SourceIndependence,
} from "./cross-source-intelligence";
import type { EntryThesis } from "./entry-thesis";
import type { SourceNarratives } from "./source-narrative";

export type CrossSourceState =
  | "confirmed"
  | "social_leads"
  | "chain_leads"
  | "divergence"
  | "risk_dominates"
  | "insufficient";

export type CrossSourceThesis = {
  state: CrossSourceState;
  headline: string;
  currentSituation: string;
  sequence: string;
  interpretation: string;
  entryMeaning: string;
  agreements: string[];
  contradictions: string[];
  nextEvidence: string[];
  confidence: number;
  independence: SourceIndependence;
  chronology: CrossSourceChronology;
};

type Args = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  chain: ChainAnalysis | null;
  market: Market | null;
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  narratives: SourceNarratives;
  entry: EntryThesis;
};

function unique(rows: Array<string | null | undefined>) {
  return [...new Set(rows.filter((row): row is string => Boolean(row?.trim())).map((row) => row.trim()))];
}

function chainBias(chain: ChainAnalysis | null) {
  const wallets = chain?.wallets || [];
  const smart = wallets.filter((row) => row.smartClassificationAvailable && row.isSmart === true);
  const smartBuyers = smart.filter((row) => numberOr(row.buys) > numberOr(row.sells)).length;
  const smartSellers = smart.filter((row) => numberOr(row.sells) > numberOr(row.buys)).length;
  const buyers = wallets.filter((row) => numberOr(row.buys) > numberOr(row.sells)).length;
  const sellers = wallets.filter((row) => numberOr(row.sells) > numberOr(row.buys)).length;
  const wash = wallets.filter((row) => row.isWashTrader === true).length;
  const directional = buyers + sellers;
  return {
    wallets: wallets.length,
    smartBuyers,
    smartSellers,
    buyerShare: directional ? (buyers / directional) * 100 : 50,
    washShare: wallets.length ? (wash / wallets.length) * 100 : 0,
  };
}

function aiCrossView(ai: AiEnvelope | null) {
  if (!ai || ai.available === false || !ai.result) return null;
  const result = ai.result as typeof ai.result & {
    finalIntelligence?: {
      socialState?: string;
      marketState?: string;
      manipulationAssessment?: string;
    };
  };
  return unique([
    result.finalIntelligence?.socialState,
    result.finalIntelligence?.marketState,
    result.finalIntelligence?.manipulationAssessment,
  ]).join(" ") || null;
}

function lagText(label: string, value: number | null) {
  if (value == null) return null;
  const abs = Math.abs(value).toFixed(1);
  return value >= 0 ? `${label}: +${abs} мин` : `${label}: -${abs} мин`;
}

export function buildCrossSourceThesis(args: Args): CrossSourceThesis {
  const { x, telegram, chain, market, derived, ai, narratives, entry } = args;
  const intelligence = buildCrossSourceIntelligence({ x, telegram, chain, market, derived });
  const { independence, chronology } = intelligence;
  const available = Number(Boolean(x)) + Number(Boolean(telegram)) + Number(Boolean(chain)) + Number(Boolean(market?.pair));
  const chainData = chainBias(chain);
  const positiveSources = [narratives.x, narratives.telegram, narratives.chain].filter((row) => row.tone === "positive").length;
  const negativeSources = [narratives.x, narratives.telegram, narratives.chain].filter((row) => row.tone === "negative").length;
  const socialPositive = narratives.x.tone === "positive" || narratives.telegram.tone === "positive";
  const socialNegative = narratives.x.tone === "negative" && narratives.telegram.tone === "negative";
  const chainPositive = narratives.chain.tone === "positive" || chainData.smartBuyers > chainData.smartSellers || chainData.buyerShare >= 58;
  const chainNegative = narratives.chain.tone === "negative" || chainData.smartSellers > chainData.smartBuyers || chainData.buyerShare <= 42;
  const highManipulation = derived.manipulation >= 60 || chainData.washShare >= 10;
  const independenceStrong = independence.verdict === "strong";
  const independenceWeak = independence.verdict === "concentrated" || (independence.concentrationRisk ?? 0) >= 65;

  let state: CrossSourceState;
  if (available < 2 || independence.availableLayers < 2) state = "insufficient";
  else if ((highManipulation && negativeSources >= 1) || independenceWeak) state = "risk_dominates";
  else if (socialPositive && chainNegative) state = "divergence";
  else if (socialNegative && chainPositive) state = "chain_leads";
  else if (socialPositive && chainPositive && positiveSources >= 2 && independenceStrong) state = "confirmed";
  else if (socialPositive && !chainPositive && !chainNegative) state = "social_leads";
  else if (chainPositive && !socialPositive) state = "chain_leads";
  else if (socialPositive && chainPositive && positiveSources >= 2) state = "confirmed";
  else state = "divergence";

  let sequence = chronology.summary;
  const lags = unique([
    lagText("smart wallet → TG", chronology.walletToTelegramMinutes),
    lagText("TG → X", chronology.telegramToXMinutes),
    lagText("X → market", chronology.xToMarketMinutes),
  ]);
  if (lags.length) sequence += ` Лаги: ${lags.join(" · ")}.`;
  if (chronology.priceLedSocial) {
    sequence += " Price impulse появился раньше доступного social evidence — часть X/TG активности могла быть реакцией на уже начавшееся движение.";
  }
  if (derived.price.leadLagMinutes != null) {
    const lag = Math.abs(derived.price.leadLagMinutes).toFixed(1);
    sequence += derived.price.leadDirection === "SOCIAL → PRICE"
      ? ` Отдельный lead/lag-модуль также видит social раньше цены примерно на ${lag} мин.`
      : derived.price.leadDirection === "PRICE → SOCIAL"
        ? ` Отдельный lead/lag-модуль также видит цену раньше social примерно на ${lag} мин.`
        : " Отдельный lead/lag-модуль считает social и цену почти синхронными.";
  }

  const agreements: string[] = [];
  const contradictions: string[] = [];
  const nextEvidence: string[] = [];

  if (socialPositive) agreements.push("X/Telegram дают положительное social-подтверждение текущему интересу.");
  if (chainPositive) agreements.push(`On-chain поток поддерживает тезис: smart buyers ${chainData.smartBuyers}, smart sellers ${chainData.smartSellers}, buyer share около ${Math.round(chainData.buyerShare)}%.`);
  if (positiveSources >= 2) agreements.push(`${positiveSources} из 3 основных источников имеют положительный narrative-тон.`);
  if (entry.evidenceSupportScore >= 70) agreements.push(`Общий evidence support высокий: ${Math.round(entry.evidenceSupportScore)}/100.`);
  if (derived.organic >= 65) agreements.push(`Social выглядит сравнительно органичным (${Math.round(derived.organic)}/100).`);
  if (independenceStrong) agreements.push(`Подтверждение действительно многослойное: ${independence.independentLayers} независимых слоя, independence ${Math.round(independence.score ?? 0)}/100.`);
  if ((chronology.alignmentScore ?? 0) >= 67 && chronology.orderableStages >= 3) agreements.push(`Cross-source chronology согласована примерно на ${Math.round(chronology.alignmentScore ?? 0)}% при coverage ${Math.round(chronology.coverage)}%.`);

  if (socialPositive && chainNegative) contradictions.push("Social выглядит сильнее, чем реальный поток кошельков: внимание пока не подтверждается качеством on-chain спроса.");
  if (chainPositive && socialNegative) contradictions.push("On-chain выглядит лучше social: покупки есть, но общественное внимание пока не подтверждает устойчивое распространение.");
  if (derived.manipulation >= 60) contradictions.push(`Высокий manipulation score ${Math.round(derived.manipulation)}/100 снижает доверие к количеству social-сигналов.`);
  if (chainData.washShare >= 10) contradictions.push(`Wash-признаки затрагивают около ${Math.round(chainData.washShare)}% классифицированных кошельков; часть объёма может не отражать независимый спрос.`);
  if (independenceWeak) contradictions.push(`Source concentration risk ${Math.round(independence.concentrationRisk ?? 0)}/100: несколько видимых подтверждений могут быть одной и той же волной, а не независимыми фактами.`);
  if (chronology.priceLedSocial) contradictions.push("Market impulse предшествует доступному social evidence; поздние репосты нельзя считать ранним подтверждением входа.");
  if ((chronology.alignmentScore ?? 100) < 50 && chronology.orderableStages >= 3) contradictions.push("Фактическая chronology плохо совпадает с ранним сценарием smart wallet → TG → X → market; momentum мог формироваться в другом порядке.");
  if (entry.priceState === "overheated_vs_signal" || entry.priceState === "stretched_vs_signal") contradictions.push("Даже при сильных источниках текущая цена уже опережает качество подтверждения.");
  if (entry.priceState === "unstable_vs_signal") contradictions.push("Резкая ценовая нестабильность не позволяет считать снижение простой скидкой относительно сигнала.");

  if (!chain) nextEvidence.push("Нужно on-chain подтверждение покупательского потока.");
  if (chain && !chainPositive) nextEvidence.push("Нужен перевес smart/buyer потока в сторону покупателей.");
  if (!x || !telegram) nextEvidence.push("Нужно подтверждение второго social-источника, чтобы отличить локальный шум от cross-platform распространения.");
  if (independence.independentLayers < 2) nextEvidence.push("Нужен как минимум второй независимый слой, а не дополнительный репост внутри уже существующей social-волны.");
  if (chronology.coverage < 75) nextEvidence.push("Нужны timestamps недостающих chronology-стадий, чтобы отличить раннее обнаружение от реакции на уже случившийся памп.");
  if (entry.priceState === "overheated_vs_signal" || entry.priceState === "stretched_vs_signal") nextEvidence.push("Нужен откат/консолидация либо новый независимый импульс спроса, который оправдает текущую цену.");
  if (entry.priceState === "unstable_vs_signal") nextEvidence.push("Нужна стабилизация цены и прекращение доминирования продавцов; только после этого снижение можно оценивать как улучшение входа.");
  if (derived.manipulation >= 60) nextEvidence.push("Нужно расширение органических авторов/каналов без роста координационных признаков.");

  const aiView = aiCrossView(ai);
  const independenceContext = independence.score == null
    ? "Независимость источников пока не измерена."
    : `Source independence ${Math.round(independence.score)}/100, concentration risk ${Math.round(independence.concentrationRisk ?? 0)}/100, независимых слоёв ${independence.independentLayers}/${independence.availableLayers}.`;
  const currentSituation = state === "confirmed"
    ? `Social и on-chain сейчас подтверждают друг друга не только по направлению, но и по независимости источников. ${independenceContext}`
    : state === "social_leads"
      ? `Основной импульс пока идёт из social. Внимание уже есть, но blockchain ещё не дал достаточно сильного независимого подтверждения. ${independenceContext}`
      : state === "chain_leads"
        ? `On-chain выглядит сильнее social: реальные кошельки показывают спрос раньше или увереннее, чем X/Telegram. ${independenceContext}`
        : state === "risk_dominates"
          ? `Количество активности сейчас менее важно, чем её качество: coordination/manipulation/wash или source concentration делают видимый импульс менее надёжным. ${independenceContext}`
          : state === "divergence"
            ? `Источники расходятся. Один слой поддерживает движение, другой его не подтверждает, поэтому общий score нельзя читать как однозначный сигнал. ${independenceContext}`
            : `Недостаточно независимых источников, чтобы построить надёжную cross-source картину. ${independenceContext}`;

  let interpretation = state === "confirmed"
    ? "Это наиболее качественный тип подтверждения: разные источники дают сходный ответ и не сводятся к одной цепочке репостов/связанных кошельков. Но цена входа всё равно оценивается отдельно — подтверждённый токен может уже быть перегрет."
    : state === "social_leads"
      ? "Такое движение может продолжиться на momentum, но оно уязвимо: если social не конвертируется в независимый on-chain спрос, цена может быстро потерять поддержку."
      : state === "chain_leads"
        ? "Покупки без широкой social-поддержки иногда дают ранний сигнал, но также могут быть локальной активностью нескольких кошельков. Нужна проверка распределения спроса и последующей chronology."
        : state === "risk_dominates"
          ? "Высокая активность не равна качественному спросу. При координации/wash/source concentration важнее независимые покупатели и устойчивость ликвидности, чем число сообщений или трейдов."
          : state === "divergence"
            ? "Расхождение — причина снизить уверенность, а не усреднить всё в один красивый score. Система должна дождаться факта, который разрешит противоречие."
            : "Без минимум двух независимых слоёв нельзя уверенно объяснить, что именно сейчас двигает монету.";
  if (aiView) interpretation += ` Qwen: ${aiView}`;

  const entryMeaning = entry.action === "strong_entry"
    ? "Cross-source структура поддерживает сильный входной тезис, если цена остаётся в допустимом диапазоне, independence не деградирует и on-chain поток не разворачивается."
    : entry.action === "consider"
      ? "Вход можно рассматривать, но только с учётом отмеченных противоречий, source concentration и того, что часть импульса уже могла быть в цене."
      : entry.action === "wait_confirmation"
        ? "Сейчас ключевое действие системы — ждать независимого подтверждения: новый слой должен добавить новый факт, а не ещё один репост той же волны."
        : entry.action === "late_weak"
          ? "Cross-source картина может оставаться позитивной по токену, но chronology/цена показывают, что текущий момент входа уже слабый или поздний."
          : "Текущий баланс источников не оправдывает входной тезис: риск, нестабильность, концентрация подтверждения или отсутствие coverage сильнее позитивных факторов.";

  const coverage = available / 4;
  const agreementBase = state === "confirmed" ? 88 : state === "social_leads" || state === "chain_leads" ? 68 : state === "divergence" ? 48 : state === "risk_dominates" ? 38 : 25;
  const independenceQuality = independence.confirmationQuality ?? 35;
  const chronologyQuality = chronology.alignmentScore == null
    ? chronology.coverage * 0.55
    : chronology.alignmentScore * 0.65 + chronology.coverage * 0.35;
  const confidence = clamp(
    agreementBase * 0.30
      + entry.confidence * 0.20
      + Math.min(100, derived.price.leadLagConfidence ?? 50) * 0.10
      + coverage * 100 * 0.10
      + independenceQuality * 0.20
      + chronologyQuality * 0.10
      - contradictions.length * 2.5,
  );

  const headline = state === "confirmed"
    ? "Независимые источники подтверждают друг друга"
    : state === "social_leads"
      ? "Social ведёт, blockchain ещё должен добавить независимый спрос"
      : state === "chain_leads"
        ? "Blockchain сильнее social — возможен ранний on-chain сигнал"
        : state === "risk_dominates"
          ? "Активности много, но независимость подтверждения слабая"
          : state === "divergence"
            ? "Источники расходятся — chronology и independence важнее общего score"
            : "Недостаточно независимых источников для общего вывода";

  return {
    state,
    headline,
    currentSituation,
    sequence,
    interpretation,
    entryMeaning,
    agreements: unique(agreements).slice(0, 8),
    contradictions: unique(contradictions).slice(0, 8),
    nextEvidence: unique(nextEvidence).slice(0, 8),
    confidence,
    independence,
    chronology,
  };
}
