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
import {
  firstCallerReputation,
  telegramCollectorStatus,
  telegramCoverageConfidence,
  telegramTokenIntelligence,
  type TelegramCollectorStatusView,
} from "./telegram-intelligence-view";

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

function appendSentence(base: string, sentence: string | null) {
  if (!sentence) return base;
  const left = base.toLowerCase().replace(/\s+/g, " ");
  const right = sentence.toLowerCase().replace(/\s+/g, " ");
  if (left.includes(right) || right.includes(left)) return base;
  return `${base} ${sentence}`;
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

function telegramCoverageExplanation(tg: SocialTimeline | null) {
  const collector = telegramCollectorStatus(tg);
  const coverageConfidence = telegramCoverageConfidence(tg);
  const coverageNote = coverageConfidence == null
    ? "Coverage confidence пока не вычисляется из-за отсутствия рабочего collector."
    : `Текущий coverage confidence: ${coverageConfidence}/100; это оценка качества наблюдаемого universe, а не вероятность отсутствия сообщений.`;

  if (!tg) {
    return {
      situation: "Telegram backend не ответил, поэтому система не знает, есть ли обсуждение токена в отслеживаемых источниках.",
      detail: "Нужно восстановить соединение с Telegram backend; до этого источник исключён из оценки.",
      state: "source unavailable",
      coverageNote,
    };
  }

  if (collector?.mode === "public_web") {
    const channels = collector.public_web_channels ?? collector.monitored_channels ?? 0;
    const validated = collector.registry?.validated ?? 0;
    if (collector.last_scan_at) {
      return {
        situation: `Telegram: публичное web-покрытие. В активном universe ${channels} каналов, validated registry ${validated}; в последнем проходе обработано ${collector.last_scan_messages ?? 0} сообщений, но по этому mint за выбранное окно совпадений нет.`,
        detail: `Public Web покрывает только найденные/настроенные публичные каналы и не видит private groups. Пустой результат не считается bearish-сигналом и не означает тишину во всём Telegram. ${coverageNote}`,
        state: "public web index empty",
        coverageNote,
      };
    }
    return {
      situation: `Telegram Public Web fallback настроен на ${channels} публичных каналов, но успешный history scan ещё не зафиксирован.`,
      detail: collector.last_error
        ? `Последний public-web scan завершился ошибкой: ${collector.last_error}. Пока источник не влияет на входной тезис. ${coverageNote}`
        : `Нужно дождаться фонового bounded public-web scan; private groups этим режимом всё равно не покрываются. ${coverageNote}`,
      state: "public web pending",
      coverageNote,
    };
  }

  if (collector?.mode === "unavailable" || collector?.configured === false) {
    return {
      situation: "Telegram API отвечает, но ни MTProto collector, ни Public Web fallback сейчас не дают покрытия.",
      detail: `Настрой MTProto либо TG_PUBLIC_WEB_ENABLED + seed universe. Без collector нельзя трактовать пустой индекс как отсутствие обсуждения. ${coverageNote}`,
      state: "collector not configured",
      coverageNote,
    };
  }

  if (collector?.mode === "mtproto" && collector.session_configured === false) {
    return {
      situation: "Telegram MTProto знает API credentials, но пользовательская session не подключена. История и realtime сейчас не собираются.",
      detail: `Нужна авторизованная TG_SESSION_STRING либо включённый Public Web fallback; пока Telegram не влияет на входной тезис. ${coverageNote}`,
      state: "session missing",
      coverageNote,
    };
  }

  if (collector?.mode === "mtproto" && collector.running === false) {
    return {
      situation: "Telegram MTProto collector настроен, но realtime monitor сейчас остановлен. Поэтому свежие сообщения не попадают в локальный индекс автоматически.",
      detail: `Фоновый runtime должен поднять monitor либо Public Web fallback; нулевой индекс означает отсутствие покрытия, а не тишину в Telegram. ${coverageNote}`,
      state: "monitor stopped",
      coverageNote,
    };
  }

  if (collector?.mode === "mtproto" && collector.running) {
    return {
      situation: `Telegram MTProto collector работает и отслеживает ${collector.monitored_channels ?? 0} каналов, но по этому mint за выбранное окно совпадений не найдено. Это вывод только по отслеживаемому universe каналов, не по всему Telegram.`,
      detail: `Покрытие расширяется через discovery registry, но private/недоступные источники всё равно могут отсутствовать. ${coverageNote}`,
      state: "monitored index empty",
      coverageNote,
    };
  }

  return {
    situation: "В локальном Telegram-индексе нет пригодных сообщений по этому mint за выбранное окно. Это отсутствие покрытия в текущем индексе, а не доказательство того, что токен нигде не обсуждают.",
    detail: `Проверь collector и universe каналов. Пока индекс пуст, Telegram не влияет на решение о входе. ${coverageNote}`,
    state: "index empty",
    coverageNote,
  };
}

function annotateTelegramCollector(
  base: SourceNarrative,
  collector: TelegramCollectorStatusView | null,
  coverageConfidence: number | null,
): SourceNarrative {
  if (!collector) return base;
  const coverageParameter = coverageConfidence == null ? [] : [{
    label: "Coverage confidence",
    value: `${coverageConfidence}/100`,
    note: "качество наблюдаемого Telegram universe; не вероятность исхода и не bearish/ bullish score",
  }];
  if (collector.mode === "public_web") {
    const channels = collector.public_web_channels ?? collector.monitored_channels ?? 0;
    return {
      ...base,
      currentSituation: `Telegram: публичное web-покрытие. ${base.currentSituation}`,
      warningEvidence: [
        ...base.warningEvidence,
        "Public Web анализирует только найденные/настроенные публичные каналы; private groups и весь остальной Telegram не покрываются.",
      ],
      parameters: [
        ...base.parameters,
        {
          label: "Telegram collector",
          value: "public_web",
          note: `${channels} публичных каналов · background history refresh без MTProto session`,
        },
        ...coverageParameter,
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
        ...coverageParameter,
      ],
    };
  }
  return base;
}

function annotateTelegramIntelligence(
  base: SourceNarrative,
  tg: SocialTimeline | null,
): SourceNarrative {
  const intelligence = telegramTokenIntelligence(tg);
  const coordination = intelligence?.coordination;
  if (!coordination || coordination.sources <= 0) return base;

  const risk = coordination.coordinationRisk;
  const independence = coordination.sourceIndependenceScore;
  const firstCaller = firstCallerReputation(intelligence);
  const sourceSentence = coordination.sources >= 2
    ? `Из ${coordination.sources} Telegram-источников эвристика оценивает примерно ${coordination.independentSources} как независимые и ${coordination.coordinatedSources} как возможные репосты/скоординированные распространители.`
    : "Зафиксирован один Telegram-источник, поэтому независимость нескольких коллеров пока подтвердить нельзя.";

  let interpretation: string | null = null;
  let entryMeaning: string | null = null;
  const warnings = [...base.warningEvidence];
  const positives = [...base.positiveEvidence];
  if (risk != null && coordination.sources >= 2) {
    if (risk >= 65) {
      interpretation = `Coordination risk ${Math.round(risk)}/100: быстрые похожие публикации/forward-связи больше похожи на один импульс с усилителями, чем на много независимых подтверждений.`;
      entryMeaning = "Количество Telegram-каналов нельзя считать равным числу независимых подтверждений входа; вес social confirmation понижен.";
      warnings.push("Высокая оценка coordination risk — эвристика по времени, forward metadata и сходству текста; это не доказательство договорённости между каналами.");
    } else if (risk >= 35) {
      interpretation = `Coordination risk ${Math.round(risk)}/100: есть смешанная картина — часть источников выглядит независимой, часть может быть репост-сетью.`;
      entryMeaning = "Telegram подтверждает интерес лишь частично: важнее качество независимых первичных коллеров, чем общий count каналов.";
      warnings.push("Есть признаки повторного/быстрого распространения между частью источников.");
    } else {
      interpretation = `Coordination risk ${Math.round(risk)}/100: наблюдаемые источники в основном выглядят независимыми по доступным timestamp/forward/text признакам.`;
      entryMeaning = "Независимое Telegram-подтверждение выглядит сильнее, но всё ещё ограничено текущим universe каналов.";
      positives.push("Низкая наблюдаемая зависимость между Telegram-источниками усиливает качество social confirmation.");
    }
  }

  if (firstCaller?.reputationScore != null) {
    const label = `Первый caller ${firstCaller.username}: reputation ${Math.round(firstCaller.reputationScore)}/100, timing ${Math.round(firstCaller.timingScore ?? 0)}/100, originality ${Math.round(firstCaller.originalityScore ?? 0)}/100.`;
    interpretation = appendSentence(interpretation || "", label).trim();
    if (firstCaller.reputationScore >= 70 && (firstCaller.originalityScore ?? 0) >= 60) {
      positives.push("Первый Telegram caller имеет сильную накопленную репутацию и высокий originality score в имеющейся истории.");
    } else if (firstCaller.reputationScore < 40 || (firstCaller.repostRate ?? 0) >= 0.6) {
      warnings.push("Первый Telegram caller пока имеет слабую/репост-зависимую историческую репутацию; ранний timestamp сам по себе не считается сильным подтверждением.");
    }
  }

  return {
    ...base,
    currentSituation: appendSentence(base.currentSituation, sourceSentence),
    interpretation: appendSentence(base.interpretation, interpretation),
    entryMeaning: appendSentence(base.entryMeaning, entryMeaning),
    positiveEvidence: [...new Set(positives)],
    warningEvidence: [...new Set(warnings)],
    parameters: [
      ...base.parameters,
      { label: "TG sources", value: String(coordination.sources), note: "уникальные источники по этому mint" },
      { label: "Independent sources", value: String(coordination.independentSources), note: "детерминированная оценка после forward/text/timing clustering" },
      { label: "Coordinated/repost", value: String(coordination.coordinatedSources), note: "возможные усилители; не доказательство координации" },
      ...(risk == null ? [] : [{ label: "Coordination risk", value: `${Math.round(risk)}/100`, note: "эвристика, не вероятность манипуляции" }]),
      ...(independence == null ? [] : [{ label: "Source independence", value: `${Math.round(independence)}/100`, note: "100 = меньше наблюдаемых зависимостей" }]),
      ...(coordination.leader ? [{ label: "Earliest TG source", value: coordination.leader, note: coordination.spreadMinutes == null ? "первый наблюдаемый источник" : `spread ${coordination.spreadMinutes.toFixed(1)} мин` }] : []),
      ...(firstCaller?.reputationScore == null ? [] : [{ label: "First caller reputation", value: `${Math.round(firstCaller.reputationScore)}/100`, note: `${firstCaller.calls} calls · first ${firstCaller.firstCalls} · repost rate ${Math.round((firstCaller.repostRate ?? 0) * 100)}%${firstCaller.medianLeadMinutes == null ? "" : ` · median lead ${firstCaller.medianLeadMinutes.toFixed(1)}м`}` }]),
    ],
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
  const collector = telegramCollectorStatus(args.tg);
  const coverageConfidence = telegramCoverageConfidence(args.tg);
  const telegram = telegramAvailable
    ? annotateTelegramIntelligence(
        annotateTelegramCollector(deterministic.telegram, collector, coverageConfidence),
        args.tg,
      )
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
          ...(coverageConfidence == null ? [] : [{
            label: "Coverage confidence",
            value: `${coverageConfidence}/100`,
            note: "качество наблюдаемого universe; не вероятность отсутствия Telegram-активности",
          }]),
          ...(collector ? [{
            label: "Collector",
            value: collector.mode ?? (collector.running ? "running" : "stopped"),
            note: collector.mode === "public_web"
              ? `public channels ${collector.public_web_channels ?? collector.monitored_channels ?? 0} · validated ${collector.registry?.validated ?? 0} · last scan messages ${collector.last_scan_messages ?? 0}`
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
