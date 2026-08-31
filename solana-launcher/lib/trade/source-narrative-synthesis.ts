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

type TelegramCollectorStatus = {
  mode?: "mtproto" | "public_web" | "unavailable" | string;
  configured?: boolean;
  mtproto_configured?: boolean;
  session_configured?: boolean;
  running?: boolean;
  connected?: boolean;
  monitored_channels?: number;
  public_web_enabled?: boolean;
  public_web_configured?: boolean;
  public_web_channels?: number;
  last_scan_at?: string | null;
  last_scan_messages?: number;
  last_scan_matches?: number;
  last_error?: string | null;
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

function collectorStatus(tg: SocialTimeline | null): TelegramCollectorStatus | null {
  const meta = tg?.meta as (SocialTimeline["meta"] & { telegramCollector?: TelegramCollectorStatus }) | undefined;
  return meta?.telegramCollector ?? null;
}

function telegramCoverageExplanation(tg: SocialTimeline | null) {
  const collector = collectorStatus(tg);
  if (!tg) {
    return {
      situation: "Telegram backend не ответил, поэтому система не знает, есть ли обсуждение токена в отслеживаемых источниках.",
      detail: "Нужно восстановить соединение с Telegram backend; до этого источник исключён из оценки.",
      state: "source unavailable",
    };
  }

  if (collector?.mode === "public_web") {
    const channels = collector.public_web_channels ?? collector.monitored_channels ?? 0;
    if (collector.last_scan_at) {
      return {
        situation: `Telegram: публичное web-покрытие. Просканировано ${channels} публичных каналов; в последнем проходе обработано ${collector.last_scan_messages ?? 0} сообщений, но по этому mint за выбранное окно совпадений нет.`,
        detail: "Public Web покрывает только настроенные публичные каналы и не видит private groups. Пустой результат не считается bearish-сигналом и не означает тишину во всём Telegram.",
        state: "public web index empty",
      };
    }
    return {
      situation: `Telegram Public Web fallback настроен на ${channels} публичных каналов, но успешный history scan ещё не зафиксирован.`,
      detail: collector.last_error
        ? `Последний public-web scan завершился ошибкой: ${collector.last_error}. Пока источник не влияет на входной тезис.`
        : "Нужно дождаться или запустить bounded public-web scan; private groups этим режимом всё равно не покрываются.",
      state: "public web pending",
    };
  }

  if (collector?.mode === "unavailable" || collector?.configured === false) {
    return {
      situation: "Telegram API отвечает, но ни MTProto collector, ни Public Web fallback сейчас не дают покрытия.",
      detail: "Настрой MTProto либо TG_PUBLIC_WEB_ENABLED + список публичных каналов. Без collector нельзя трактовать пустой индекс как отсутствие обсуждения.",
      state: "collector not configured",
    };
  }

  if (collector?.mode === "mtproto" && collector.session_configured === false) {
    return {
      situation: "Telegram MTProto знает API credentials, но пользовательская session не подключена. История и realtime сейчас не собираются.",
      detail: "Нужна авторизованная TG_SESSION_STRING либо включённый Public Web fallback; пока Telegram не влияет на входной тезис.",
      state: "session missing",
    };
  }

  if (collector?.mode === "mtproto" && collector.running === false) {
    return {
      situation: "Telegram MTProto collector настроен, но realtime monitor сейчас остановлен. Поэтому свежие сообщения не попадают в локальный индекс автоматически.",
      detail: "Запусти monitor/worker или Public Web fallback; нулевой индекс означает отсутствие покрытия, а не тишину в Telegram.",
      state: "monitor stopped",
    };
  }

  if (collector?.mode === "mtproto" && collector.running) {
    return {
      situation: `Telegram MTProto collector работает и отслеживает ${collector.monitored_channels ?? 0} каналов, но по этому mint за выбранное окно совпадений не найдено. Это вывод только по отслеживаемому universe каналов, не по всему Telegram.`,
      detail: "Чтобы расширить покрытие, нужно добавить релевантные каналы/источники в monitored or scanned universe.",
      state: "monitored index empty",
    };
  }

  return {
    situation: "В локальном Telegram-индексе нет пригодных сообщений по этому mint за выбранное окно. Это отсутствие покрытия в текущем индексе, а не доказательство того, что токен нигде не обсуждают.",
    detail: "Проверь collector и набор отслеживаемых каналов. Пока индекс пуст, Telegram не влияет на решение о входе.",
    state: "index empty",
  };
}

function annotateTelegramCollector(
  base: SourceNarrative,
  collector: TelegramCollectorStatus | null,
): SourceNarrative {
  if (!collector) return base;
  if (collector.mode === "public_web") {
    const channels = collector.public_web_channels ?? collector.monitored_channels ?? 0;
    return {
      ...base,
      currentSituation: `Telegram: публичное web-покрытие. ${base.currentSituation}`,
      warningEvidence: [
        ...base.warningEvidence,
        "Public Web анализирует только настроенные публичные каналы; private groups и весь остальной Telegram не покрываются.",
      ],
      parameters: [
        ...base.parameters,
        {
          label: "Telegram collector",
          value: "public_web",
          note: `${channels} публичных каналов · history scan без MTProto session`,
        },
      ],
    };
  }
  if (collector.mode === "mtproto") {
    return {
      ...base,
      parameters: [
        ...base.parameters,
        {
          label: "Telegram collector",
          value: "mtproto",
          note: `${collector.monitored_channels ?? 0} каналов · history + realtime при запущенном monitor`,
        },
      ],
    };
  }
  return base;
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
  const coverage = telegramCoverageExplanation(args.tg);
  const collector = collectorStatus(args.tg);
  const telegram = telegramAvailable
    ? annotateTelegramCollector(deterministic.telegram, collector)
    : unavailable(
        deterministic.telegram,
        coverage.situation,
        coverage.detail,
        [
          {
            label: "Indexed TG events",
            value: String(Math.max(telegramMatched, telegramRetained)),
            note: args.tg ? "совпадения в текущем локальном индексе" : "источник не ответил",
          },
          {
            label: "Coverage state",
            value: coverage.state,
            note: "нулевое покрытие не трактуется как bearish-сигнал",
          },
          ...(collector ? [{
            label: "Collector",
            value: collector.mode ?? (collector.running ? "running" : "stopped"),
            note: collector.mode === "public_web"
              ? `public channels ${collector.public_web_channels ?? collector.monitored_channels ?? 0} · last scan messages ${collector.last_scan_messages ?? 0}`
              : `configured ${collector.configured ? "yes" : "no"} · session ${collector.session_configured ? "yes" : "no"} · channels ${collector.monitored_channels ?? 0}`,
          }] : []),
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
