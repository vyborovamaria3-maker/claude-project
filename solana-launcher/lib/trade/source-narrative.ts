import {
  clamp,
  numberOr,
  toTimestamp,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type DerivedSocial,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";

export type NarrativeTone = "positive" | "mixed" | "negative" | "unknown";

export type NarrativeMetric = {
  label: string;
  value: string;
  note?: string;
};

export type SourceNarrative = {
  source: "x" | "telegram" | "chain";
  tone: NarrativeTone;
  headline: string;
  currentSituation: string;
  interpretation: string;
  entryMeaning: string;
  keyActors: string[];
  positiveEvidence: string[];
  warningEvidence: string[];
  parameters: NarrativeMetric[];
  confidence: number;
};

export type SourceNarratives = {
  x: SourceNarrative;
  telegram: SourceNarrative;
  chain: SourceNarrative;
};

type BuildSourceNarrativesArgs = {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  chain: ChainAnalysis | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
};

type TimeSeriesPulse = {
  recent: number;
  previous: number;
  state: "accelerating" | "steady" | "cooling" | "insufficient";
};

function norm(value: string | null | undefined) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function shortAddress(value: string) {
  return value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function compact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function pct(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function ratePct(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.abs(parsed) <= 1 ? parsed * 100 : parsed);
}

function unique<T>(rows: T[]) {
  return [...new Set(rows)];
}

function pulseFromTimes(times: number[]): TimeSeriesPulse {
  if (times.length < 4) return { recent: 0, previous: 0, state: "insufficient" };
  const sorted = [...times].sort((a, b) => a - b);
  const latest = sorted[sorted.length - 1];
  const recentStart = latest - 30 * 60_000;
  const previousStart = latest - 60 * 60_000;
  const recent = sorted.filter((time) => time >= recentStart).length;
  const previous = sorted.filter((time) => time >= previousStart && time < recentStart).length;
  if (recent >= Math.max(3, previous * 1.5)) return { recent, previous, state: "accelerating" };
  if (previous >= Math.max(3, recent * 1.5)) return { recent, previous, state: "cooling" };
  return { recent, previous, state: "steady" };
}

function toneFromScore(score: number, risk = 0): NarrativeTone {
  const adjusted = score - risk * 0.35;
  if (adjusted >= 67) return "positive";
  if (adjusted <= 38) return "negative";
  return "mixed";
}

function aiCampaignLine(ai: AiEnvelope | null) {
  const result = ai?.available === false ? null : ai?.result;
  const hypothesis = result?.campaignHypothesis;
  if (!hypothesis?.narrative) return null;
  const confidence = Number(hypothesis.confidence);
  if (Number.isFinite(confidence) && confidence < 0.45) return null;
  return hypothesis.narrative.trim();
}

function buildXNarrative(
  x: TwitterStats | null,
  derived: DerivedSocial,
  ai: AiEnvelope | null,
): SourceNarrative {
  if (!x) {
    return {
      source: "x",
      tone: "unknown",
      headline: "Что происходит сейчас в X: данных недостаточно",
      currentSituation: "Источник X сейчас не дал пригодную выборку, поэтому система не делает вывод о настроении сообщества или качестве продвижения.",
      interpretation: "Отсутствие данных не считается негативным сигналом — этот источник просто исключается из содержательного вывода.",
      entryMeaning: "Не использовать X как подтверждение входа, пока источник не восстановится.",
      keyActors: [],
      positiveEvidence: [],
      warningEvidence: ["Нет достаточной выборки X для проверки органики и координации."],
      parameters: [],
      confidence: 0,
    };
  }

  const totalTweets = x.riskUniverse?.totalTweets ?? x.totalTweets ?? 0;
  const uniqueAuthors = x.riskUniverse?.uniqueAuthors ?? x.uniqueMentioners ?? 0;
  const suspiciousTweets = x.riskUniverse?.suspiciousTweets ?? x.topTweets.filter((tweet) => tweet.isSuspicious).length;
  const suspiciousShare = totalTweets > 0 ? clamp((suspiciousTweets / totalTweets) * 100) : 0;
  const botRisk = clamp(x.riskUniverse?.botRiskScore ?? x.botRiskScore ?? 0);
  const botRatio = clamp((x.riskUniverse?.botRatio ?? x.aggregated?.botRatio ?? 0) * ((x.riskUniverse?.botRatio ?? x.aggregated?.botRatio ?? 0) <= 1 ? 100 : 1));
  const verified = x.aggregated?.verifiedAuthors ?? x.shillers.filter((row) => row.isVerified).length;
  const topActors = [...(x.shillers || [])]
    .sort((a, b) => {
      const aReach = (a.followers || 0) + a.totalEngagement * 5 + (a.isVerified ? 50_000 : 0);
      const bReach = (b.followers || 0) + b.totalEngagement * 5 + (b.isVerified ? 50_000 : 0);
      return bReach - aReach;
    })
    .slice(0, 4);
  const topShare = totalTweets > 0 && topActors[0]
    ? clamp((topActors[0].tweets / totalTweets) * 100)
    : 0;
  const times = (x.topTweets || [])
    .map((tweet) => toTimestamp(tweet.timestamp))
    .filter((time): time is number => time != null);
  const pulse = pulseFromTimes(times);
  const influential = topActors.filter((row) => row.isVerified || (row.followers || 0) >= 50_000);
  const campaignLine = aiCampaignLine(ai);

  const positiveEvidence: string[] = [];
  const warningEvidence: string[] = [];

  if (pulse.state === "accelerating") {
    positiveEvidence.push(`В доступной выборке публикации ускорились: ${pulse.recent} за последние 30 минут против ${pulse.previous} в предыдущие 30 минут.`);
  } else if (pulse.state === "cooling") {
    warningEvidence.push(`Темп публикаций в доступной выборке замедляется: ${pulse.recent} за последние 30 минут против ${pulse.previous} ранее.`);
  }
  if (influential.length > 0) {
    positiveEvidence.push(`${influential.length} заметных авторов с крупным охватом или verified-статусом участвуют в распространении.`);
  }
  if (derived.organic >= 65) positiveEvidence.push(`Органичность социального распространения оценивается в ${Math.round(derived.organic)}/100.`);
  if (botRisk >= 55) warningEvidence.push(`Бот-риск высокий: ${Math.round(botRisk)}/100.`);
  if (suspiciousShare >= 20) warningEvidence.push(`Подозрительные публикации составляют около ${Math.round(suspiciousShare)}% наблюдаемой активности.`);
  if (topShare >= 35) warningEvidence.push(`Большая доля активности сосредоточена вокруг одного промо-аккаунта (${Math.round(topShare)}%).`);
  if (derived.manipulation >= 60) warningEvidence.push(`Общий manipulation score повышен: ${Math.round(derived.manipulation)}/100.`);

  const organicEnough = derived.organic >= 60 && botRisk < 50 && suspiciousShare < 20;
  const coordinated = botRisk >= 55 || suspiciousShare >= 25 || topShare >= 35 || derived.manipulation >= 60;
  const accelerating = pulse.state === "accelerating";
  const tone = toneFromScore(derived.xScore, Math.max(botRisk, derived.manipulation));

  const situation = accelerating
    ? `В X внимание к токену в доступной выборке ускоряется. Сейчас видно ${uniqueAuthors} уникальных авторов при ${totalTweets} упоминаниях${influential.length ? `, включая ${influential.length} заметных аккаунта(ов)` : ""}.`
    : pulse.state === "cooling"
      ? `Обсуждение токена в X остаётся заметным, но темп публикаций в доступной выборке охлаждается. Сейчас учтено ${uniqueAuthors} уникальных авторов при ${totalTweets} упоминаниях.`
      : `В X токен обсуждают ${uniqueAuthors} уникальных авторов при ${totalTweets} упоминаниях. Явного ускорения по доступным timestamp пока не видно.`;

  const interpretation = coordinated
    ? `Внимание нельзя считать полностью органическим: присутствуют признаки координации или искусственного усиления. ${campaignLine ? `AI-критик также отмечает: ${campaignLine}` : ""}`.trim()
    : organicEnough
      ? `Распространение сейчас выглядит сравнительно органичным: бот-риск и доля подозрительных публикаций не доминируют, а внимание распределено шире одного промо-аккаунта.${campaignLine ? ` Дополнительная AI-интерпретация: ${campaignLine}` : ""}`
      : `Картина смешанная: интерес есть, но данных недостаточно, чтобы считать движение полностью органическим или явно скоординированным.${campaignLine ? ` AI-критик добавляет: ${campaignLine}` : ""}`;

  const entryMeaning = coordinated && accelerating
    ? "Для входа это поддерживает краткосрочный momentum, но качество сигнала ниже из-за риска организованного промо. Нужна проверка Telegram и on-chain подтверждения."
    : accelerating && organicEnough
      ? "Для входа X сейчас даёт позитивное подтверждение: внимание расширяется без сильного доминирования бот-/координационных признаков."
      : pulse.state === "cooling"
        ? "Для входа X сейчас слабее: социальный импульс не наращивается, поэтому лучше требовать подтверждение от Telegram и блокчейна."
        : "X сейчас даёт нейтрально-смешанное подтверждение; самостоятельно этот источник не должен определять момент входа.";

  return {
    source: "x",
    tone,
    headline: "Что происходит сейчас в X / Twitter",
    currentSituation: situation,
    interpretation,
    entryMeaning,
    keyActors: topActors.map((row) => {
      const handle = row.handle.startsWith("@") ? row.handle : `@${row.handle}`;
      const reach = row.followers ? `${compact(row.followers)} подписчиков` : `${compact(row.totalEngagement)} вовлечений`;
      return `${handle} — ${reach}${row.isBot ? " · бот-риск" : row.isVerified ? " · verified" : ""}`;
    }),
    positiveEvidence: unique(positiveEvidence),
    warningEvidence: unique(warningEvidence),
    parameters: [
      { label: "Упоминания", value: totalTweets.toLocaleString("ru-RU") },
      { label: "Уникальные авторы", value: uniqueAuthors.toLocaleString("ru-RU") },
      { label: "X score", value: `${Math.round(derived.xScore)}/100` },
      { label: "Органичность", value: `${Math.round(derived.organic)}/100` },
      { label: "Manipulation", value: `${Math.round(derived.manipulation)}/100` },
      { label: "Bot risk", value: `${Math.round(botRisk)}/100` },
      { label: "Bot ratio", value: pct(botRatio) },
      { label: "Подозрительные посты", value: pct(suspiciousShare) },
      { label: "Verified authors", value: verified.toLocaleString("ru-RU") },
      { label: "Engagement", value: compact(x.aggregated?.totalEngagement) },
    ],
    confidence: clamp(35 + Math.min(35, uniqueAuthors * 2) + Math.min(20, totalTweets / 5) - (x.collectionTruncated ? 10 : 0)),
  };
}

function buildTelegramNarrative(
  tg: SocialTimeline | null,
  channels: Channel[],
  derived: DerivedSocial,
  x: TwitterStats | null,
): SourceNarrative {
  if (!tg) {
    return {
      source: "telegram",
      tone: "unknown",
      headline: "Что происходит сейчас в Telegram: данных недостаточно",
      currentSituation: "Telegram-источник сейчас не дал пригодную выборку, поэтому система не делает вывод о calls, качестве каналов или синхронности продвижения.",
      interpretation: "Отсутствие данных Telegram не считается негативным сигналом.",
      entryMeaning: "Не использовать Telegram как подтверждение входа до восстановления источника.",
      keyActors: [],
      positiveEvidence: [],
      warningEvidence: ["Нет достаточной Telegram-выборки."],
      parameters: [],
      confidence: 0,
    };
  }

  const channelMap = new Map<string, Channel>();
  for (const channel of channels) {
    for (const key of [norm(channel.username), norm(channel.title)]) {
      if (key) channelMap.set(key, channel);
    }
  }

  const telegramRows = (tg.timeline || []).filter((item) => !item.platform || item.platform.toLowerCase() === "telegram");
  const grouped = new Map<string, {
    name: string;
    messages: number;
    calls: number;
    times: number[];
    channel: Channel | null;
  }>();

  let explicitCalls = 0;
  const allTimes: number[] = [];
  const callTimes: number[] = [];

  for (const item of telegramRows) {
    const display = item.source_handle || item.source_name || "unknown";
    const key = norm(display);
    const existing = grouped.get(key) || {
      name: display,
      messages: 0,
      calls: 0,
      times: [],
      channel: channelMap.get(key) || null,
    };
    existing.messages += 1;
    const eventType = String(item.event_type || "").toLowerCase();
    const metrics = item.metrics || {};
    const isCall = eventType.includes("call") || metrics.explicit_call === true || metrics.is_call === true;
    if (isCall) {
      explicitCalls += 1;
      existing.calls += 1;
    }
    const timestamp = toTimestamp(item.occurred_at);
    if (timestamp != null) {
      existing.times.push(timestamp);
      allTimes.push(timestamp);
      if (isCall) callTimes.push(timestamp);
    }
    grouped.set(key, existing);
  }

  const sources = [...grouped.values()].sort((a, b) => {
    const aScore = (a.channel?.score || 0) + a.calls * 18 + a.messages * 2;
    const bScore = (b.channel?.score || 0) + b.calls * 18 + b.messages * 2;
    return bScore - aScore;
  });
  const highQuality = sources.filter((row) => (row.channel?.score || 0) >= 70 && (ratePct(row.channel?.rug_rate) ?? 0) < 35);
  const risky = sources.filter((row) => (ratePct(row.channel?.rug_rate) ?? 0) >= 40 || (row.channel?.score ?? 100) < 35);
  const pulse = pulseFromTimes(allTimes);

  const sourceFirstTimes = sources
    .map((row) => row.times.length ? Math.min(...row.times) : null)
    .filter((time): time is number => time != null)
    .sort((a, b) => a - b);
  const synchronized = sourceFirstTimes.length >= 3 && (sourceFirstTimes[Math.min(sourceFirstTimes.length - 1, 2)] - sourceFirstTimes[0]) <= 10 * 60_000;

  const firstCall = callTimes.length ? Math.min(...callTimes) : null;
  const xTimes = (x?.topTweets || [])
    .map((tweet) => toTimestamp(tweet.timestamp))
    .filter((time): time is number => time != null);
  const firstX = xTimes.length ? Math.min(...xTimes) : null;
  const leadMinutes = firstCall != null && firstX != null ? (firstX - firstCall) / 60_000 : null;

  const positiveEvidence: string[] = [];
  const warningEvidence: string[] = [];
  if (explicitCalls > 0) positiveEvidence.push(`В выборке есть ${explicitCalls} явных Telegram call-сигналов.`);
  if (highQuality.length > 0) positiveEvidence.push(`${highQuality.length} канал(а/ов) с рейтингом ≥70 и без высокой rug-истории участвуют в обсуждении.`);
  if (pulse.state === "accelerating") positiveEvidence.push(`Telegram-активность ускоряется в доступной выборке: ${pulse.recent} сообщений за последние 30 минут против ${pulse.previous} ранее.`);
  if (risky.length > 0) warningEvidence.push(`${risky.length} активных источника(ов) имеют слабый рейтинг или повышенную rug-историю.`);
  if (synchronized) warningEvidence.push("Несколько каналов подключились в узком временном окне; это может быть координированным cross-posting, а не независимыми сигналами.");
  if (pulse.state === "cooling") warningEvidence.push("Темп Telegram-сообщений в доступной выборке охлаждается.");

  const tone = toneFromScore(derived.tgScore, risky.length > highQuality.length ? 45 : synchronized ? 25 : 0);
  const matched = tg.meta?.matchedBeforeLimit ?? tg.mentions ?? telegramRows.length;

  let currentSituation = `В Telegram найдено ${telegramRows.length} сообщений в текущей выборке и ${matched} совпадений до лимита. Активны ${sources.length} источника(ов)`;
  if (explicitCalls > 0) currentSituation += `, из них ${explicitCalls} сообщений классифицированы как прямые calls`;
  currentSituation += ".";
  if (pulse.state === "accelerating") currentSituation += " Темп обсуждения сейчас ускоряется.";
  if (pulse.state === "cooling") currentSituation += " Темп обсуждения сейчас снижается.";

  let interpretation = highQuality.length >= 2 && risky.length < highQuality.length
    ? "Сигнал поддерживают несколько относительно качественных каналов, поэтому Telegram выглядит сильнее простого массового упоминания."
    : highQuality.length > 0
      ? "Есть хотя бы один качественный источник, но подтверждение со стороны остальных каналов пока неоднородное."
      : "Количество сообщений само по себе не подтверждает качество сигнала: сильных по истории каналов в текущей выборке мало или нет.";
  if (synchronized) interpretation += " При этом близкий тайминг публикаций повышает вероятность организованного распространения.";
  if (leadMinutes != null && Math.abs(leadMinutes) >= 3) {
    interpretation += leadMinutes > 0
      ? ` В доступной выборке первый явный TG-call появился примерно на ${Math.round(leadMinutes)} мин раньше первой наблюдаемой X-публикации.`
      : ` В доступной выборке X опередил первый явный TG-call примерно на ${Math.round(Math.abs(leadMinutes))} мин.`;
  }

  const entryMeaning = highQuality.length >= 2 && explicitCalls > 0 && risky.length <= highQuality.length
    ? "Telegram сейчас даёт содержательное подтверждение импульса, но окончательный вход стоит сверять с поведением smart/whale кошельков."
    : risky.length > highQuality.length || synchronized
      ? "Telegram подтверждает наличие промо, но качество такого подтверждения ограничено: возможна координация или слабая история источников."
      : "Telegram сейчас даёт смешанное подтверждение; без on-chain поддержки его недостаточно для сильного входного тезиса.";

  return {
    source: "telegram",
    tone,
    headline: "Что происходит сейчас в Telegram",
    currentSituation,
    interpretation,
    entryMeaning,
    keyActors: sources.slice(0, 5).map((row) => {
      const channel = row.channel;
      const score = channel?.score != null ? `рейтинг ${Math.round(channel.score)}/100` : "рейтинг неизвестен";
      const calls = row.calls ? ` · calls ${row.calls}` : "";
      return `${row.name || "unknown"} — ${score}${calls}`;
    }),
    positiveEvidence: unique(positiveEvidence),
    warningEvidence: unique(warningEvidence),
    parameters: [
      { label: "Сообщения", value: telegramRows.length.toLocaleString("ru-RU") },
      { label: "Совпадения до лимита", value: matched.toLocaleString("ru-RU") },
      { label: "Активные источники", value: sources.length.toLocaleString("ru-RU") },
      { label: "Прямые calls", value: explicitCalls.toLocaleString("ru-RU") },
      { label: "Качественные источники", value: highQuality.length.toLocaleString("ru-RU") },
      { label: "Рискованные источники", value: risky.length.toLocaleString("ru-RU") },
      { label: "Telegram score", value: `${Math.round(derived.tgScore)}/100` },
      { label: "Cross-posting", value: synchronized ? "синхронность повышена" : "явной синхронности нет" },
      { label: "TG → X timing", value: leadMinutes == null ? "—" : `${leadMinutes > 0 ? "+" : ""}${Math.round(leadMinutes)} мин`, note: "Положительное значение означает, что TG-call наблюдался раньше X в доступной выборке." },
    ],
    confidence: clamp(30 + Math.min(30, sources.length * 6) + Math.min(25, telegramRows.length * 1.5) + (highQuality.length > 0 ? 10 : 0) - (tg.meta?.truncated ? 10 : 0)),
  };
}

function buildChainNarrative(
  chain: ChainAnalysis | null,
): SourceNarrative {
  if (!chain) {
    return {
      source: "chain",
      tone: "unknown",
      headline: "Что происходит сейчас в блокчейне: данных недостаточно",
      currentSituation: "On-chain анализ ещё не дал пригодную классификацию кошельков.",
      interpretation: "Пока нельзя подтвердить, кто именно набирает или разгружает позицию.",
      entryMeaning: "Не считать социальный импульс подтверждённым блокчейном до загрузки классификации.",
      keyActors: [],
      positiveEvidence: [],
      warningEvidence: ["Нет достаточной on-chain классификации."],
      parameters: [],
      confidence: 0,
    };
  }

  const wallets = chain.wallets || [];
  const smart = wallets.filter((wallet) => wallet.smartClassificationAvailable && wallet.isSmart === true);
  const smartBuyers = smart.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells));
  const smartSellers = smart.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys));
  const fresh = wallets.filter((wallet) => wallet.freshnessVerified && wallet.isFresh === true);
  const wash = wallets.filter((wallet) => wallet.isWashTrader === true);
  const buyers = wallets.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells));
  const sellers = wallets.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys));
  const whales = wallets.filter((wallet) => numberOr(wallet.volumeSol) >= 10 && !wallet.isWashTrader);
  const whaleBuyers = whales.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells));
  const whaleSellers = whales.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys));
  const bundleWallets = new Set<string>();
  for (const bundle of chain.bundles || []) {
    for (const address of bundle.wallets || []) bundleWallets.add(address);
  }
  const bundleShare = wallets.length ? (bundleWallets.size / wallets.length) * 100 : 0;
  const washShare = wallets.length ? (wash.length / wallets.length) * 100 : 0;
  const classifiedDirectional = buyers.length + sellers.length;
  const buyerShare = classifiedDirectional ? (buyers.length / classifiedDirectional) * 100 : 50;

  const positiveEvidence: string[] = [];
  const warningEvidence: string[] = [];

  if (smartBuyers.length > smartSellers.length) positiveEvidence.push(`Smart-wallet bias положительный: ${smartBuyers.length} преимущественно покупающих против ${smartSellers.length} преимущественно продающих.`);
  if (buyerShare >= 58) positiveEvidence.push(`По агрегированному поведению классифицированных кошельков покупатели преобладают (${Math.round(buyerShare)}%).`);
  if (fresh.length >= Math.max(3, wallets.length * 0.12)) positiveEvidence.push(`Заметна доля fresh wallets: ${fresh.length} из ${wallets.length}. Это совместимо с притоком новых участников, но не доказывает качество спроса.`);
  if (smartSellers.length > smartBuyers.length) warningEvidence.push(`Smart-wallet bias отрицательный: ${smartSellers.length} преимущественно продающих против ${smartBuyers.length} покупающих.`);
  if (whaleSellers.length > whaleBuyers.length) warningEvidence.push(`Среди крупных по объёму кошельков продавцов больше, чем покупателей (${whaleSellers.length} против ${whaleBuyers.length}).`);
  if (wash.length > 0) warningEvidence.push(`Wash-признаки обнаружены у ${wash.length} кошелька(ов), около ${Math.round(washShare)}% классифицированной выборки.`);
  if (bundleShare >= 15) warningEvidence.push(`Около ${Math.round(bundleShare)}% кошельков текущей выборки входят в обнаруженные bundles.`);
  if (chain.summary?.historyTruncated || chain.truncated) warningEvidence.push("On-chain история усечена, поэтому вывод по структуре потока имеет ограниченное покрытие.");

  const score = clamp(
    50
      + (buyerShare - 50) * 0.55
      + (smartBuyers.length - smartSellers.length) * 8
      + (whaleBuyers.length - whaleSellers.length) * 3
      - washShare * 0.8
      - bundleShare * 0.25,
  );
  const risk = clamp(washShare * 2 + bundleShare * 0.7 + Math.max(0, 50 - buyerShare));
  const tone = toneFromScore(score, risk);

  let currentSituation = `On-chain классификация охватывает ${wallets.length} кошельков и ${chain.trades?.length || chain.summary?.totalTrades || 0} трейдов. `;
  if (smartBuyers.length > smartSellers.length) {
    currentSituation += "Smart-wallet кошельки сейчас по агрегированному числу действий чаще выглядят как набирающие позицию, чем как разгружающие.";
  } else if (smartSellers.length > smartBuyers.length) {
    currentSituation += "Smart-wallet кошельки по агрегированному поведению чаще выглядят как сокращающие позицию.";
  } else {
    currentSituation += "У smart-wallet кошельков явного перевеса покупателей или продавцов нет.";
  }

  let interpretation = buyerShare >= 58
    ? "Структура классифицированных кошельков склоняется в сторону покупателей."
    : buyerShare <= 42
      ? "Структура классифицированных кошельков склоняется в сторону продавцов."
      : "Общий баланс классифицированных покупателей и продавцов близок к нейтральному.";
  if (fresh.length > 0) interpretation += ` Fresh wallets: ${fresh.length}; это указывает на приток новых адресов, но не гарантирует органический спрос.`;
  if (wash.length > 0 || bundleShare >= 15) interpretation += " Часть активности нельзя трактовать как чистый независимый спрос из-за wash/bundle-признаков.";

  const entryMeaning = smartBuyers.length > smartSellers.length && buyerShare >= 55 && washShare < 10
    ? "Blockchain сейчас подтверждает социальный импульс: сильные классифицированные кошельки и общий wallet-bias не противоречат входному тезису."
    : smartSellers.length > smartBuyers.length || whaleSellers.length > whaleBuyers.length
      ? "Blockchain сейчас ухудшает качество входа: сильные или крупные кошельки чаще склоняются к разгрузке, поэтому социальный шум может не подтверждаться деньгами."
      : washShare >= 10 || bundleShare >= 25
        ? "On-chain активность выглядит шумной: перед входом нужно отделять реальный спрос от wash/bundle-активности."
        : "Blockchain даёт смешанное подтверждение: явного smart-money перевеса нет, поэтому лучше ждать более выраженного направленного потока.";

  const topActors = [...wallets]
    .sort((a, b) => numberOr(b.volumeSol) - numberOr(a.volumeSol))
    .slice(0, 5)
    .map((wallet) => {
      const buys = numberOr(wallet.buys);
      const sells = numberOr(wallet.sells);
      const role = wallet.isWashTrader
        ? "wash"
        : wallet.smartClassificationAvailable && wallet.isSmart
          ? "smart"
          : wallet.freshnessVerified && wallet.isFresh
            ? "fresh"
            : numberOr(wallet.volumeSol) >= 10
              ? "large"
              : "wallet";
      const direction = buys > sells ? "покупает" : sells > buys ? "продаёт" : "смешанно";
      return `${shortAddress(wallet.address)} — ${role} · ${direction} · ${numberOr(wallet.volumeSol).toFixed(1)} SOL`;
    });

  return {
    source: "chain",
    tone,
    headline: "Что происходит сейчас в блокчейне",
    currentSituation,
    interpretation,
    entryMeaning,
    keyActors: topActors,
    positiveEvidence: unique(positiveEvidence),
    warningEvidence: unique(warningEvidence),
    parameters: [
      { label: "Кошельки", value: wallets.length.toLocaleString("ru-RU") },
      { label: "Трейды", value: (chain.trades?.length || chain.summary?.totalTrades || 0).toLocaleString("ru-RU") },
      { label: "Smart buyers", value: smartBuyers.length.toLocaleString("ru-RU") },
      { label: "Smart sellers", value: smartSellers.length.toLocaleString("ru-RU") },
      { label: "Buyer wallet bias", value: pct(buyerShare) },
      { label: "Fresh wallets", value: fresh.length.toLocaleString("ru-RU") },
      { label: "Wash wallets", value: wash.length.toLocaleString("ru-RU") },
      { label: "Wash share", value: pct(washShare) },
      { label: "Bundles", value: (chain.bundles || []).length.toLocaleString("ru-RU") },
      { label: "Bundle wallet share", value: pct(bundleShare) },
      { label: "Large buyers", value: whaleBuyers.length.toLocaleString("ru-RU") },
      { label: "Large sellers", value: whaleSellers.length.toLocaleString("ru-RU") },
    ],
    confidence: clamp(
      30
        + Math.min(35, wallets.length * 1.4)
        + Math.min(20, (chain.trades?.length || chain.summary?.totalTrades || 0) / 25)
        + (smart.length > 0 ? 10 : 0)
        - (chain.summary?.historyTruncated || chain.truncated ? 15 : 0),
    ),
  };
}

export function buildSourceNarratives(args: BuildSourceNarrativesArgs): SourceNarratives {
  return {
    x: buildXNarrative(args.x, args.derived, args.ai),
    telegram: buildTelegramNarrative(args.tg, args.channels, args.derived, args.x),
    chain: buildChainNarrative(args.chain),
  };
}
