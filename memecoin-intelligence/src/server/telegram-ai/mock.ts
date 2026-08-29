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

export function mockTelegramAnalysis(messages: TelegramMessageInput[], context: TelegramAnalysisContext = {}): TelegramAiResult {
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
    featureAssessments: [],
    discoveredRelationships: [],
    relationships,
    coordinationSignals,
    anomalies: [],
    contradictions: [],
    whatWouldChangeConclusion: [],
    campaignHypothesis: { label: messages.length < 3 ? 'insufficient_data' : coordinated ? 'coordinated' : 'organic', confidence: messages.length < 3 ? 0.35 : coordinated ? 0.78 : 0.58, likelyOriginators: originator ? [originator] : [], amplifiers: sorted.slice(1).map(channelLabel).filter((value, index, values) => values.indexOf(value) === index).slice(0, 20), narrative: coordinated ? 'Repeated content, shared links, or tight timing suggest cross-channel amplification.' : 'The observed messages look more diverse than synchronized.', evidenceMessageIds: coordinationSignals.flatMap((signal) => signal.evidenceMessageIds).filter((id, index, ids) => ids.indexOf(id) === index) },
    risks: coordinationSignals.length ? [{ type: 'coordinated_promotion', severity: coordinated ? 'high' : 'medium', confidence: 0.75, explanation: 'Coordination indicators should be reviewed before treating message volume as organic demand.', evidenceMessageIds: coordinationSignals.flatMap((signal) => signal.evidenceMessageIds).filter((id, index, ids) => ids.indexOf(id) === index) }] : [],
    reasoningSummary: [
      `${new Set(messages.map(channelLabel)).size} distinct Telegram channels were present.`,
      `${contracts.size} contract addresses and ${tickers.size} tickers were extracted.`,
      `${coordinationSignals.length} coordination indicators were detected by deterministic rules.`,
    ],
    overallConfidence: Math.min(0.9, 0.4 + messages.length / 80),
  };
}
