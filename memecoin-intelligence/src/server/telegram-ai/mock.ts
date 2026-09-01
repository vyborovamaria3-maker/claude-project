import { createHash } from 'node:crypto';
import type { TelegramAiResult, TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';

const CONTRACT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?\b/g;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9_]{1,19})\b/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const POSITIVE = /\b(bullish|moon|gem|strong|buy|рост|ракета|покуп|памп)\b/i;
const NEGATIVE = /\b(scam|rug|warning|avoid|sell|скам|раг|опас|продаж)\b/i;

function normalized(text: string) {
  return text.toLowerCase().replace(URL_RE, ' ').replace(CONTRACT_RE, ' ').replace(/[^\p{L}\p{N}\s$]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function channelLabel(message: TelegramMessageInput) {
  return message.channelUsername ? `@${message.channelUsername.replace(/^@/, '')}` : message.channelTitle || message.channelId;
}

function snapshotFeature(context: TelegramAnalysisContext, key: string) {
  const feature = context.intelligenceSnapshot?.features.find((row) => row.key === key);
  if (!feature || feature.missing) return null;
  const raw = feature.numericValue ?? feature.value;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function featureKeys(context: TelegramAnalysisContext, matcher: (key: string) => boolean) {
  return (context.intelligenceSnapshot?.features || [])
    .filter((feature) => !feature.missing && matcher(feature.key))
    .map((feature) => feature.key)
    .slice(0, 8);
}

function mockSourceAssessments(
  context: TelegramAnalysisContext,
  coordinated: boolean,
  sentimentScore: number,
): NonNullable<TelegramAiResult['sourceAssessments']> | undefined {
  const snapshot = context.intelligenceSnapshot;
  if (context.analysisMode !== 'full_intelligence' || !snapshot) return undefined;
  const social = snapshotFeature(context, 'scores.social');
  const xScore = snapshotFeature(context, 'scores.x');
  const tgScore = snapshotFeature(context, 'scores.telegram');
  const organic = snapshotFeature(context, 'scores.organic');
  const manipulation = snapshotFeature(context, 'scores.manipulation');
  const xKeys = featureKeys(context, (key) => key.startsWith('x_twitter.') || key === 'scores.x' || key === 'scores.organic' || key === 'scores.manipulation');
  const tgKeys = featureKeys(context, (key) => key.startsWith('telegram.') || key === 'scores.telegram' || key === 'scores.organic' || key === 'scores.manipulation');
  const chainKeys = featureKeys(context, (key) => key.startsWith('price_event_evidence.') || key.includes('on_chain') || key.includes('wallet'));
  const walletCount = snapshot.rawSummary.wallets;
  const tradeCount = snapshot.rawSummary.trades;

  return {
    x: {
      currentSituation: xScore == null
        ? 'В mock-режиме нет достаточной X-оценки для отдельного вывода.'
        : `X даёт сигнал ${Math.round(xScore)}/100${social != null ? ` при общем social ${Math.round(social)}/100` : ''}.`,
      interpretation: coordinated || (manipulation ?? 0) >= 60
        ? 'Внимание нельзя считать полностью органическим: координационные или manipulation-признаки повышены.'
        : organic != null && organic >= 65
          ? `Распространение выглядит сравнительно органичным: organic ${Math.round(organic)}/100.`
          : 'Качество X-сигнала смешанное; mock не повышает уверенность только из-за количества публикаций.',
      entryImpact: xScore != null && xScore >= 65 && !coordinated
        ? 'X поддерживает входной тезис, но не заменяет market/on-chain подтверждение.'
        : 'X пока не даёт достаточно чистого независимого подтверждения текущего входа.',
      supportingFeatureKeys: xKeys,
      confidence: xScore == null ? 0.45 : 0.62,
    },
    telegram: {
      currentSituation: `В snapshot учтено ${snapshot.rawSummary.telegramMessages} Telegram-сообщений${tgScore != null ? `, TG score ${Math.round(tgScore)}/100` : ''}.`,
      interpretation: coordinated
        ? 'В Telegram есть признаки синхронного распространения; количество сообщений может переоценивать независимый интерес.'
        : sentimentScore > 0.15
          ? 'Telegram-тон скорее позитивный, но mock не считает позитивный текст доказательством реального спроса.'
          : 'Telegram-картина смешанная или нейтральная; важнее качество каналов и подтверждение другими источниками.',
      entryImpact: tgScore != null && tgScore >= 65 && !coordinated
        ? 'Telegram поддерживает текущий тезис как дополнительный источник, если market и blockchain не расходятся с ним.'
        : 'Telegram сам по себе не оправдывает вход по текущей цене.',
      supportingFeatureKeys: tgKeys,
      confidence: 0.62,
    },
    chain: {
      currentSituation: `On-chain snapshot содержит ${walletCount} кошельков и ${tradeCount} трейдов.`,
      interpretation: walletCount > 0
        ? 'Mock видит наличие on-chain активности, но не будет придумывать направление smart-money без соответствующих направленных feature.'
        : 'Данных кошельков недостаточно для содержательного on-chain вывода.',
      entryImpact: walletCount > 0
        ? 'Blockchain должен подтверждать качество спроса; одних social-сигналов недостаточно.'
        : 'Без классифицированных кошельков on-chain не может подтверждать текущий вход.',
      supportingFeatureKeys: chainKeys,
      confidence: walletCount > 0 ? 0.55 : 0.35,
    },
  };
}

function mockEntryAssessment(
  context: TelegramAnalysisContext,
  coordinated: boolean,
  sentimentScore: number,
): NonNullable<TelegramAiResult['entryAssessment']> | undefined {
  if (context.analysisMode !== 'full_intelligence' || !context.intelligenceSnapshot) return undefined;
  const marketAvailable = Boolean(context.intelligenceSnapshot.rawSummary.marketAvailable);
  const early = snapshotFeature(context, 'scores.early');
  const organic = snapshotFeature(context, 'scores.organic');
  const manipulation = snapshotFeature(context, 'scores.manipulation');
  const alpha = snapshotFeature(context, 'scores.alpha');
  const social = snapshotFeature(context, 'scores.social');

  if (!marketAvailable) {
    return {
      priceState: 'unknown',
      entryAction: 'wait_confirmation',
      oneLineVerdict: 'Недостаточно свежих market/price данных, чтобы оценить текущую цену относительно сигнала; социальный интерес сам по себе не делает вход качественным.',
      whyNow: social != null && social >= 65 ? [`Social score ${Math.round(social)}/100 показывает заметный интерес.`] : [],
      alreadyPricedIn: [],
      missingConfirmation: ['Нужны свежие market/price данные и on-chain подтверждение текущего спроса.'],
      invalidation: coordinated ? ['Скоординированное продвижение может завышать видимую силу social-сигнала.'] : [],
      confidence: 0.42,
    };
  }

  const manipulationHigh = (manipulation ?? 0) >= 60 || coordinated;
  const earlyLow = early != null && early <= 40;
  const earlyHigh = early != null && early >= 65;
  const supportStrong = (alpha ?? 50) >= 65 && (social ?? 50) >= 65 && sentimentScore >= -0.1;

  const priceState = earlyLow
    ? 'stretched_vs_signal' as const
    : earlyHigh && supportStrong && !manipulationHigh
      ? 'reasonable_vs_signal' as const
      : manipulationHigh
        ? 'stretched_vs_signal' as const
        : 'reasonable_vs_signal' as const;
  const entryAction = earlyLow
    ? 'late_weak' as const
    : supportStrong && !manipulationHigh
      ? 'consider' as const
      : 'wait_confirmation' as const;

  const whyNow = [
    supportStrong ? `Social/alpha подтверждение выглядит рабочим: social ${Math.round(social ?? 0)}/100, alpha ${Math.round(alpha ?? 0)}/100.` : null,
    organic != null && organic >= 65 ? `Органичность ${Math.round(organic)}/100 поддерживает качество внимания.` : null,
  ].filter((row): row is string => Boolean(row));
  const alreadyPricedIn = [
    earlyLow ? `Early score ${Math.round(early ?? 0)}/100 указывает, что часть импульса уже могла быть реализована до текущего момента.` : null,
    manipulationHigh ? 'Часть видимого social momentum может быть результатом координации и уже отражаться в цене.' : null,
  ].filter((row): row is string => Boolean(row));
  const missingConfirmation = [
    entryAction !== 'consider' ? 'Нужен новый независимый on-chain или market-сигнал, а не только продолжение social-промо.' : null,
  ].filter((row): row is string => Boolean(row));
  const invalidation = [
    manipulationHigh ? `Manipulation/coordination risk остаётся повышенным${manipulation != null ? ` (${Math.round(manipulation)}/100)` : ''}.` : null,
  ].filter((row): row is string => Boolean(row));

  return {
    priceState,
    entryAction,
    oneLineVerdict: entryAction === 'consider'
      ? 'Текущий момент можно рассматривать: сигнал ещё не выглядит поздним, но нужен контроль on-chain подтверждения и отсутствия резкого перегрева.'
      : entryAction === 'late_weak'
        ? 'Текущий вход выглядит поздним относительно доступного сигнала: часть движения, вероятно, уже реализована, поэтому лучше ждать улучшения цены или нового подтверждения.'
        : 'Сейчас лучше ждать подтверждения: данных достаточно для интереса к монете, но недостаточно для сильного входного тезиса по текущей цене.',
    whyNow,
    alreadyPricedIn,
    missingConfirmation,
    invalidation,
    confidence: 0.62,
  };
}

export function mockTelegramAnalysis(
  messages: TelegramMessageInput[],
  context: TelegramAnalysisContext = {
    analysisMode: 'telegram_only',
    analysisRole: 'analyst',
  },
): TelegramAiResult {
  const sorted = [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.id.localeCompare(b.id));
  const contracts = new Map<string, Set<string>>();
  const tickers = new Map<string, Set<string>>();
  const links = new Map<string, Set<string>>();
  const textGroups = new Map<string, TelegramMessageInput[]>();
  let positive = 0;
  let negative = 0;

  for (const message of sorted) {
    for (const contract of message.text.match(CONTRACT_RE) ?? []) {
      if (!contracts.has(contract)) contracts.set(contract, new Set());
      contracts.get(contract)!.add(message.id);
    }
    for (const match of message.text.matchAll(TICKER_RE)) {
      const ticker = match[1]!.toUpperCase();
      if (!tickers.has(ticker)) tickers.set(ticker, new Set());
      tickers.get(ticker)!.add(message.id);
    }
    for (const link of [...message.links, ...(message.text.match(URL_RE) ?? [])]) {
      const clean = link.replace(/[),.;!?\]]+$/, '');
      if (!links.has(clean)) links.set(clean, new Set());
      links.get(clean)!.add(message.id);
    }
    const key = normalized(message.text);
    if (key.length >= 16) {
      const fingerprint = createHash('sha1').update(key).digest('hex');
      const group = textGroups.get(fingerprint) ?? [];
      group.push(message);
      textGroups.set(fingerprint, group);
    }
    if (POSITIVE.test(message.text)) positive += 1;
    if (NEGATIVE.test(message.text)) negative += 1;
  }

  const coordinationSignals: TelegramAiResult['coordinationSignals'] = [];
  const relationships: TelegramAiResult['relationships'] = [];
  for (const group of textGroups.values()) {
    const channels = new Set(group.map(channelLabel));
    if (group.length < 2 || channels.size < 2) continue;
    const ids = group.map((message) => message.id);
    coordinationSignals.push({ type: 'copied_text', severity: group.length >= 4 ? 'high' : 'medium', confidence: 0.9, explanation: `Near-identical text appeared in ${channels.size} channels.`, evidenceMessageIds: ids });
    const first = group[0]!;
    for (const other of group.slice(1)) relationships.push({ source: channelLabel(other), target: channelLabel(first), type: 'copies', confidence: 0.85, rationale: 'Messages have the same normalized text and the source message was earlier.', evidenceMessageIds: [first.id, other.id] });
  }
  for (const [link, idsSet] of links) {
    const ids = [...idsSet];
    if (ids.length >= 2) coordinationSignals.push({ type: 'shared_links', severity: ids.length >= 4 ? 'high' : 'low', confidence: 0.78, explanation: `The same link was shared repeatedly: ${link}`, evidenceMessageIds: ids });
  }
  const firstAt = sorted[0] ? Date.parse(sorted[0].sentAt) : 0;
  const lastAt = sorted.at(-1) ? Date.parse(sorted.at(-1)!.sentAt) : 0;
  if (sorted.length >= 3 && lastAt - firstAt <= 5 * 60_000 && new Set(sorted.map(channelLabel)).size >= 2) {
    coordinationSignals.push({ type: 'near_simultaneous_posts', severity: 'medium', confidence: 0.72, explanation: 'Several channels posted inside a five-minute window.', evidenceMessageIds: sorted.map((message) => message.id) });
  }

  const score = messages.length ? Math.max(-1, Math.min(1, (positive - negative) / messages.length)) : 0;
  const copied = coordinationSignals.some((signal) => signal.type === 'copied_text');
  const coordinated = coordinationSignals.length >= 2 || copied;
  const originator = sorted[0] ? channelLabel(sorted[0]) : null;
  const mentionedTokens: TelegramAiResult['mentionedTokens'] = [
    ...[...contracts].map(([address, ids]) => ({ address, symbol: null, name: null, confidence: 0.98, evidenceMessageIds: [...ids] })),
    ...[...tickers].map(([symbol, ids]) => ({ address: null, symbol, name: null, confidence: 0.9, evidenceMessageIds: [...ids] })),
  ];
  if (context.tokenAddress && !mentionedTokens.some((token) => token.address === context.tokenAddress)) {
    mentionedTokens.unshift({ address: context.tokenAddress, symbol: context.symbol ?? null, name: context.tokenName ?? null, confidence: 0.6, evidenceMessageIds: [] });
  }
  const entryAssessment = mockEntryAssessment(context, coordinated, score);
  const sourceAssessments = mockSourceAssessments(context, coordinated, score);

  return {
    summary: `Analyzed ${messages.length} Telegram messages across ${new Set(messages.map(channelLabel)).size} channels. ${coordinated ? 'The sample contains coordination indicators.' : 'No strong coordination pattern was found in the sample.'}`,
    sentiment: { label: score > 0.35 ? 'positive' : score < -0.35 ? 'negative' : positive && negative ? 'mixed' : 'neutral', score, confidence: Math.min(0.9, 0.45 + messages.length / 100) },
    dominantIntent: coordinated ? 'promotion' : positive && negative ? 'mixed' : 'discussion',
    mentionedTokens,
    entities: [
      ...[...new Set(messages.map(channelLabel))].map((value) => ({ type: 'channel' as const, value, normalizedValue: value.toLowerCase(), confidence: 1, evidenceMessageIds: messages.filter((message) => channelLabel(message) === value).map((message) => message.id) })),
      ...[...contracts].map(([value, ids]) => ({ type: 'contract' as const, value, normalizedValue: value, confidence: 0.99, evidenceMessageIds: [...ids] })),
    ],
    claims: [],
    relationships,
    coordinationSignals,
    campaignHypothesis: { label: messages.length < 3 ? 'insufficient_data' : coordinated ? 'coordinated' : 'organic', confidence: messages.length < 3 ? 0.35 : coordinated ? 0.78 : 0.58, likelyOriginators: originator ? [originator] : [], amplifiers: sorted.slice(1).map(channelLabel).filter((value, index, values) => values.indexOf(value) === index).slice(0, 20), narrative: coordinated ? 'Repeated content, shared links, or tight timing suggest cross-channel amplification.' : 'The observed messages look more diverse than synchronized.', evidenceMessageIds: coordinationSignals.flatMap((signal) => signal.evidenceMessageIds).filter((id, index, ids) => ids.indexOf(id) === index) },
    risks: coordinationSignals.length ? [{ type: 'coordinated_promotion', severity: coordinated ? 'high' : 'medium', confidence: 0.75, explanation: 'Coordination indicators should be reviewed before treating message volume as organic demand.', evidenceMessageIds: coordinationSignals.flatMap((signal) => signal.evidenceMessageIds).filter((id, index, ids) => ids.indexOf(id) === index) }] : [],
    featureAssessments: [],
    discoveredRelationships: [],
    anomalies: [],
    contradictions: [],
    whatWouldChangeConclusion: [],
    finalIntelligence: context.analysisMode === 'full_intelligence' ? {
      marketState: entryAssessment?.oneLineVerdict || 'Mock mode has limited market interpretation.',
      socialState: coordinated ? 'Social activity contains coordination indicators.' : 'Social activity is comparatively diverse in the retained sample.',
      manipulationAssessment: coordinated ? 'Coordination risk is elevated.' : 'No dominant coordination pattern was detected by mock rules.',
      bullCase: score >= 0 ? 'Positive discussion can support momentum if market and on-chain evidence confirm it.' : 'Bull case requires a reversal in sentiment and independent confirmation.',
      bearCase: coordinated ? 'Promotion may be stronger than organic demand.' : 'Momentum can fade if social attention does not translate into market/on-chain demand.',
      unknowns: ['Mock mode cannot independently validate valuation or future price behavior.'],
      confidence: 0.58,
    } : undefined,
    sourceAssessments,
    entryAssessment,
    reasoningSummary: [
      `${new Set(messages.map(channelLabel)).size} distinct Telegram channels were present.`,
      `${contracts.size} contract addresses and ${tickers.size} tickers were extracted.`,
      `${coordinationSignals.length} coordination indicators were detected by deterministic rules.`,
    ],
    overallConfidence: Math.min(0.9, 0.4 + messages.length / 80),
  };
}
