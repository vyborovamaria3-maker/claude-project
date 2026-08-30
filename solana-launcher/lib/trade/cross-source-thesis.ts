import {
  clamp,
  numberOr,
  toTimestamp,
  type AiEnvelope,
  type ChainAnalysis,
  type DerivedSocial,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
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

function firstXTime(x: TwitterStats | null) {
  const values = (x?.topTweets || [])
    .map((row) => toTimestamp(row.timestamp))
    .filter((row): row is number => row != null);
  return values.length ? Math.min(...values) : null;
}

function firstTelegramTime(tg: SocialTimeline | null, callsOnly: boolean) {
  const values: number[] = [];
  for (const row of tg?.timeline || []) {
    if (row.platform && row.platform.toLowerCase() !== "telegram") continue;
    if (callsOnly) {
      const metrics = row.metrics || {};
      const eventType = String(row.event_type || "").toLowerCase();
      if (!eventType.includes("call") && metrics.explicit_call !== true && metrics.is_call !== true) continue;
    }
    const time = toTimestamp(row.occurred_at);
    if (time != null) values.push(time);
  }
  return values.length ? Math.min(...values) : null;
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

export function buildCrossSourceThesis(args: Args): CrossSourceThesis {
  const { x, telegram, chain, market, derived, ai, narratives, entry } = args;
  const available = Number(Boolean(x)) + Number(Boolean(telegram)) + Number(Boolean(chain)) + Number(Boolean(market?.pair));
  const chainData = chainBias(chain);
  const positiveSources = [narratives.x, narratives.telegram, narratives.chain].filter((row) => row.tone === "positive").length;
  const negativeSources = [narratives.x, narratives.telegram, narratives.chain].filter((row) => row.tone === "negative").length;
  const socialPositive = narratives.x.tone === "positive" || narratives.telegram.tone === "positive";
  const socialNegative = narratives.x.tone === "negative" && narratives.telegram.tone === "negative";
  const chainPositive = narratives.chain.tone === "positive" || chainData.smartBuyers > chainData.smartSellers || chainData.buyerShare >= 58;
  const chainNegative = narratives.chain.tone === "negative" || chainData.smartSellers > chainData.smartBuyers || chainData.buyerShare <= 42;
  const highManipulation = derived.manipulation >= 60 || chainData.washShare >= 10;

  let state: CrossSourceState;
  if (available < 2) state = "insufficient";
  else if (highManipulation && negativeSources >= 1) state = "risk_dominates";
  else if (socialPositive && chainNegative) state = "divergence";
  else if (socialNegative && chainPositive) state = "chain_leads";
  else if (socialPositive && chainPositive && positiveSources >= 2) state = "confirmed";
  else if (socialPositive && !chainPositive && !chainNegative) state = "social_leads";
  else if (chainPositive && !socialPositive) state = "chain_leads";
  else state = "divergence";

  const xFirst = firstXTime(x);
  const tgCallFirst = firstTelegramTime(telegram, true);
  const tgAnyFirst = firstTelegramTime(telegram, false);
  const tgReference = tgCallFirst ?? tgAnyFirst;
  let sequence = "Точный порядок распространения между X и Telegram по доступным timestamp не установлен.";
  if (xFirst != null && tgReference != null) {
    const delta = Math.round(Math.abs(xFirst - tgReference) / 60_000);
    if (delta <= 2) {
      sequence = "X и Telegram активировались почти одновременно в доступной выборке; это больше похоже на синхронный импульс, чем на явное лидерство одного канала.";
    } else if (tgReference < xFirst) {
      sequence = `Telegram появился примерно на ${delta} мин раньше X в доступной выборке${tgCallFirst != null ? " по явному call" : ""}.`;
    } else {
      sequence = `X появился примерно на ${delta} мин раньше Telegram в доступной выборке.`;
    }
  }
  if (derived.price.leadLagMinutes != null) {
    const lag = Math.abs(derived.price.leadLagMinutes).toFixed(1);
    sequence += derived.price.leadDirection === "SOCIAL → PRICE"
      ? ` Наблюдаемый social-импульс опережал ценовой импульс примерно на ${lag} мин.`
      : derived.price.leadDirection === "PRICE → SOCIAL"
        ? ` Цена опережала social примерно на ${lag} мин — часть обсуждения могла быть реакцией на уже начавшееся движение.`
        : ` Social и цена двигались почти синхронно.`;
  }

  const agreements: string[] = [];
  const contradictions: string[] = [];
  const nextEvidence: string[] = [];

  if (socialPositive) agreements.push("X/Telegram дают положительное social-подтверждение текущему интересу.");
  if (chainPositive) agreements.push(`On-chain поток поддерживает тезис: smart buyers ${chainData.smartBuyers}, smart sellers ${chainData.smartSellers}, buyer share около ${Math.round(chainData.buyerShare)}%.`);
  if (positiveSources >= 2) agreements.push(`${positiveSources} из 3 основных источников имеют положительный narrative-тон.`);
  if (entry.evidenceSupportScore >= 70) agreements.push(`Общий evidence support высокий: ${Math.round(entry.evidenceSupportScore)}/100.`);
  if (derived.organic >= 65) agreements.push(`Social выглядит сравнительно органичным (${Math.round(derived.organic)}/100).`);

  if (socialPositive && chainNegative) contradictions.push("Social выглядит сильнее, чем реальный поток кошельков: внимание пока не подтверждается качеством on-chain спроса.");
  if (chainPositive && socialNegative) contradictions.push("On-chain выглядит лучше social: покупки есть, но общественное внимание пока не подтверждает устойчивое распространение.");
  if (derived.manipulation >= 60) contradictions.push(`Высокий manipulation score ${Math.round(derived.manipulation)}/100 снижает доверие к количеству social-сигналов.`);
  if (chainData.washShare >= 10) contradictions.push(`Wash-признаки затрагивают около ${Math.round(chainData.washShare)}% классифицированных кошельков; часть объёма может не отражать независимый спрос.`);
  if (entry.priceState === "overheated_vs_signal" || entry.priceState === "stretched_vs_signal") contradictions.push("Даже при сильных источниках текущая цена уже опережает качество подтверждения.");
  if (entry.priceState === "unstable_vs_signal") contradictions.push("Резкая ценовая нестабильность не позволяет считать снижение простой скидкой относительно сигнала.");

  if (!chain) nextEvidence.push("Нужно on-chain подтверждение покупательского потока.");
  if (chain && !chainPositive) nextEvidence.push("Нужен перевес smart/buyer потока в сторону покупателей.");
  if (!x || !telegram) nextEvidence.push("Нужно подтверждение второго social-источника, чтобы отличить локальный шум от cross-platform распространения.");
  if (entry.priceState === "overheated_vs_signal" || entry.priceState === "stretched_vs_signal") nextEvidence.push("Нужен откат/консолидация либо новый независимый импульс спроса, который оправдает текущую цену.");
  if (entry.priceState === "unstable_vs_signal") nextEvidence.push("Нужна стабилизация цены и прекращение доминирования продавцов; только после этого снижение можно оценивать как улучшение входа.");
  if (derived.manipulation >= 60) nextEvidence.push("Нужно расширение органических авторов/каналов без роста координационных признаков.");

  const aiView = aiCrossView(ai);
  const currentSituation = state === "confirmed"
    ? "Social и on-chain сейчас в целом подтверждают друг друга: внимание не существует отдельно от реального потока покупателей."
    : state === "social_leads"
      ? "Основной импульс пока идёт из social. Внимание уже есть, но blockchain ещё не дал достаточно сильного независимого подтверждения."
      : state === "chain_leads"
        ? "On-chain выглядит сильнее social: реальные кошельки показывают спрос раньше или увереннее, чем X/Telegram."
        : state === "risk_dominates"
          ? "Количество активности сейчас менее важно, чем её качество: manipulation/wash риски делают видимый импульс менее надёжным."
          : state === "divergence"
            ? "Источники расходятся. Один слой поддерживает движение, другой его не подтверждает, поэтому общий score нельзя читать как однозначный сигнал."
            : "Недостаточно независимых источников, чтобы построить надёжную cross-source картину.";

  let interpretation = state === "confirmed"
    ? "Это наиболее качественный тип подтверждения: разные источники дают сходный ответ по одной и той же монете. Но цена входа всё равно оценивается отдельно — подтверждённый токен может уже быть перегрет."
    : state === "social_leads"
      ? "Такое движение может продолжиться на momentum, но оно уязвимо: если social не конвертируется в on-chain спрос, цена может быстро потерять поддержку."
      : state === "chain_leads"
        ? "Покупки без широкой social-поддержки иногда дают ранний сигнал, но также могут быть локальной активностью нескольких кошельков. Нужна проверка распределения спроса."
        : state === "risk_dominates"
          ? "Высокая активность не равна качественному спросу. При координации/wash важнее независимые покупатели и устойчивость ликвидности, чем число сообщений или трейдов."
          : state === "divergence"
            ? "Расхождение — причина снизить уверенность, а не усреднить всё в один красивый score. Система должна дождаться факта, который разрешит противоречие."
            : "Без минимум двух независимых слоёв нельзя уверенно объяснить, что именно сейчас двигает монету.";
  if (aiView) interpretation += ` Qwen: ${aiView}`;

  const entryMeaning = entry.action === "strong_entry"
    ? "Cross-source структура поддерживает сильный входной тезис, если цена остаётся в допустимом диапазоне и on-chain поток не разворачивается."
    : entry.action === "consider"
      ? "Вход можно рассматривать, но только с учётом отмеченных противоречий и того, что часть импульса уже могла быть в цене."
      : entry.action === "wait_confirmation"
        ? "Сейчас ключевое действие системы — ждать разрешения противоречия: либо новый спрос подтвердит цену, либо слабый источник покажет, что импульс выдыхается."
        : entry.action === "late_weak"
          ? "Cross-source картина может оставаться позитивной по токену, но текущая цена уже делает момент входа слабым/поздним."
          : "Текущий баланс источников не оправдывает входной тезис: риск, нестабильность или отсутствие подтверждения сильнее позитивных факторов.";

  const coverage = available / 4;
  const agreementBase = state === "confirmed" ? 88 : state === "social_leads" || state === "chain_leads" ? 68 : state === "divergence" ? 48 : state === "risk_dominates" ? 38 : 25;
  const confidence = clamp(
    agreementBase * 0.45
      + entry.confidence * 0.25
      + Math.min(100, derived.price.leadLagConfidence ?? 50) * 0.15
      + coverage * 100 * 0.15
      - contradictions.length * 3,
  );

  const headline = state === "confirmed"
    ? "Источники подтверждают друг друга"
    : state === "social_leads"
      ? "Social ведёт, blockchain ещё должен подтвердить"
      : state === "chain_leads"
        ? "Blockchain сильнее social — возможен ранний on-chain сигнал"
        : state === "risk_dominates"
          ? "Риск качества активности сейчас важнее её количества"
          : state === "divergence"
            ? "Источники расходятся — общий score скрывает важное противоречие"
            : "Недостаточно источников для общего вывода";

  return {
    state,
    headline,
    currentSituation,
    sequence,
    interpretation,
    entryMeaning,
    agreements: unique(agreements).slice(0, 7),
    contradictions: unique(contradictions).slice(0, 7),
    nextEvidence: unique(nextEvidence).slice(0, 7),
    confidence,
  };
}
