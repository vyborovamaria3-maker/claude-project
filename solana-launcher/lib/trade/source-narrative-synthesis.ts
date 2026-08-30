import {
  clamp,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type DerivedSocial,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
import {
  buildSourceNarratives,
  type SourceNarrative,
  type SourceNarratives,
} from "./source-narrative";
import {
  hasChainIntelligence,
  hasTelegramIntelligence,
  hasXIntelligence,
} from "./intelligence-coverage";

type Args = {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  chain: ChainAnalysis | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
};

type AiSourceAssessment = {
  currentSituation?: string;
  interpretation?: string;
  entryImpact?: string;
  supportingFeatureKeys?: string[];
  confidence?: number;
};

type ExtendedResult = NonNullable<AiEnvelope["result"]> & {
  sourceAssessments?: {
    x?: AiSourceAssessment;
    telegram?: AiSourceAssessment;
    chain?: AiSourceAssessment;
  };
};

function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function qwenAssessment(
  ai: AiEnvelope | null,
  source: keyof NonNullable<ExtendedResult["sourceAssessments"]>,
): AiSourceAssessment | null {
  if (!ai || ai.available === false || !ai.result) return null;
  const result = ai.result as ExtendedResult;
  const assessment = result.sourceAssessments?.[source];
  if (!assessment) return null;
  const confidence = Number(assessment.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.45) return null;
  return assessment;
}

function appendQwen(base: string, qwen: string | null) {
  if (!qwen) return base;
  const normalizedBase = base.toLowerCase().replace(/\s+/g, " ");
  const normalizedQwen = qwen.toLowerCase().replace(/\s+/g, " ");
  if (normalizedBase.includes(normalizedQwen) || normalizedQwen.includes(normalizedBase)) return base;
  return `${base} Qwen: ${qwen}`;
}

function unavailable(
  base: SourceNarrative,
  currentSituation: string,
  detail: string,
  parameters: SourceNarrative["parameters"] = [],
): SourceNarrative {
  return {
    ...base,
    tone: "unknown",
    headline: "Недостаточно покрытия для вывода",
    currentSituation,
    interpretation: "Отсутствие пригодных событий не считается негативным сигналом и не превращается в оценку 0/100.",
    entryMeaning: "Источник исключён из подтверждения и риска текущего входа, пока не появится реальное покрытие.",
    keyActors: [],
    positiveEvidence: [],
    warningEvidence: [detail],
    parameters,
    confidence: 0,
  };
}

function mergeOne(
  base: SourceNarrative,
  assessment: AiSourceAssessment | null,
): SourceNarrative {
  if (!assessment || base.tone === "unknown") return base;
  const aiConfidenceRaw = Number(assessment.confidence);
  const aiConfidence = clamp(aiConfidenceRaw <= 1 ? aiConfidenceRaw * 100 : aiConfidenceRaw);
  const keys = Array.isArray(assessment.supportingFeatureKeys)
    ? assessment.supportingFeatureKeys.filter((key): key is string => typeof key === "string" && Boolean(key.trim())).slice(0, 8)
    : [];

  return {
    ...base,
    currentSituation: appendQwen(base.currentSituation, clean(assessment.currentSituation)),
    interpretation: appendQwen(base.interpretation, clean(assessment.interpretation)),
    entryMeaning: appendQwen(base.entryMeaning, clean(assessment.entryImpact)),
    parameters: [
      ...base.parameters,
      {
        label: "Qwen confidence",
        value: `${Math.round(aiConfidence)}%`,
        note: keys.length ? `опирается на: ${keys.join(", ")}` : "AI-интерпретация; факты остаются детерминированными",
      },
    ],
    confidence: clamp(base.confidence * 0.75 + aiConfidence * 0.25),
  };
}

export function buildSourceNarrativeSynthesis(args: Args): SourceNarratives {
  const xAvailable = hasXIntelligence(args.x);
  const telegramAvailable = hasTelegramIntelligence(args.tg);
  const chainAvailable = hasChainIntelligence(args.chain);
  const deterministic = buildSourceNarratives({
    ...args,
    x: xAvailable ? args.x : null,
    tg: telegramAvailable ? args.tg : null,
    chain: chainAvailable ? args.chain : null,
  });

  const x = xAvailable
    ? deterministic.x
    : unavailable(
        deterministic.x,
        "X-ответ пришёл без пригодных постов/авторов для этого токена.",
        "Нужны реальные X-публикации или авторы, прежде чем источник сможет менять входной тезис.",
      );

  const telegramIndexed = args.tg != null;
  const telegramMatched = Number(
    args.tg?.meta?.matchedPlatforms?.telegram
      ?? args.tg?.meta?.matchedBeforeLimit
      ?? args.tg?.platforms?.telegram
      ?? args.tg?.mentions
      ?? 0,
  );
  const telegramRetained = (args.tg?.timeline || []).filter(
    (item) => !item.platform || item.platform.toLowerCase() === "telegram",
  ).length;
  const telegram = telegramAvailable
    ? deterministic.telegram
    : unavailable(
        deterministic.telegram,
        telegramIndexed
          ? "В локальном Telegram-индексе нет пригодных сообщений по этому mint за выбранное окно. Это означает отсутствие покрытия в текущем индексе, а не доказательство того, что токен нигде не обсуждают."
          : "Telegram-источник не ответил, поэтому система не знает, есть ли обсуждение токена в отслеживаемых каналах.",
        telegramIndexed
          ? "Проверь MTProto collector/monitor и набор отслеживаемых каналов. Пока индекс пуст, Telegram не влияет на решение о входе."
          : "Нужно восстановить соединение с Telegram backend/collector; до этого источник исключён из оценки.",
        [
          {
            label: "Indexed TG events",
            value: String(Math.max(telegramMatched, telegramRetained)),
            note: telegramIndexed ? "совпадения в текущем локальном индексе" : "источник не ответил",
          },
          {
            label: "Coverage state",
            value: telegramIndexed ? "index empty" : "source unavailable",
            note: "нулевое покрытие не трактуется как bearish-сигнал",
          },
        ],
      );

  const chain = chainAvailable
    ? deterministic.chain
    : unavailable(
        deterministic.chain,
        "Blockchain-ответ не содержит кошельков, трейдов, bundle-кластеров или summary-покрытия.",
        "Нужны реальные on-chain события; пустой snapshot не считается нейтральным подтверждением.",
      );

  return {
    x: mergeOne(x, qwenAssessment(args.ai, "x")),
    telegram: mergeOne(telegram, qwenAssessment(args.ai, "telegram")),
    chain: mergeOne(chain, qwenAssessment(args.ai, "chain")),
  };
}
