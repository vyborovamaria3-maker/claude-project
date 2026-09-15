import assert from 'node:assert/strict';

import { mockTelegramAnalysis } from '@/server/telegram-ai/mock.js';
import { buildTelegramPrompt } from '@/server/telegram-ai/prompts.js';
import {
  intelligenceSnapshotSchema,
  telegramAiResultSchema,
  telegramContextSchema,
  telegramMessageSchema,
} from '@/server/telegram-ai/schemas.js';

const mint = '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump';
const createdAt = '2026-09-13T12:00:00Z';

const messages = [
  {
    id: 'smoke-tg-1',
    channelId: 'alpha-research',
    channelUsername: 'alpha_research',
    channelTitle: 'Alpha Research',
    senderId: 'alpha-analyst',
    text: '$TESTQ looks strong and buyers are active, but wait for on-chain confirmation.',
    sentAt: '2026-09-13T12:00:00Z',
    views: 4800,
    forwards: 18,
    reactions: 96,
    links: [],
  },
  {
    id: 'smoke-tg-2',
    channelId: 'sol-radar',
    channelUsername: 'sol_radar',
    channelTitle: 'Sol Radar',
    senderId: 'radar-analyst',
    text: '$TESTQ momentum looks bullish across social sources, but the move is not vertical yet.',
    sentAt: '2026-09-13T12:07:00Z',
    views: 3500,
    forwards: 11,
    reactions: 71,
    links: [],
  },
  {
    id: 'smoke-tg-3',
    channelId: 'risk-desk',
    channelUsername: 'risk_desk',
    channelTitle: 'Risk Desk',
    senderId: 'risk-analyst',
    text: 'Warning: liquidity can still be thin; avoid chasing until demand persists.',
    sentAt: '2026-09-13T12:15:00Z',
    views: 2900,
    forwards: 9,
    reactions: 55,
    links: [],
  },
].map((message) => telegramMessageSchema.parse(message));

const features = [
  ['scores.x', 'Headline scores', 'X score', 72, 'x'],
  ['scores.telegram', 'Headline scores', 'Telegram score', 68, 'telegram'],
  ['scores.social', 'Headline scores', 'Social score', 70, 'derived'],
  ['scores.organic', 'Headline scores', 'Organic score', 74, 'derived'],
  ['scores.manipulation', 'Headline scores', 'Manipulation score', 24, 'derived'],
  ['scores.alpha', 'Headline scores', 'Alpha score', 71, 'derived'],
  ['scores.early', 'Headline scores', 'Early score', 67, 'derived'],
  ['x_twitter.mentions_1h', 'X', 'X mentions 1h', 26, 'x'],
  ['wallet.smart_activity', 'On-chain', 'Smart wallet activity', 3, 'chain'],
  ['price_event_evidence.return_1h', 'Market', 'Price return 1h', 9.5, 'market'],
] as const;

const snapshot = intelligenceSnapshotSchema.parse({
  snapshotId: 'snapshot-qwen-minimal-smoke',
  version: 'social-snapshot-v2',
  graphVersion: 'entity-graph-v1.1',
  mint,
  symbol: 'TESTQ',
  tokenName: 'Qwen Smoke Token',
  createdAt,
  featureCount: features.length,
  missingFeatureCount: 0,
  features: features.map(([key, group, label, value, source]) => ({
    key,
    group,
    label,
    value,
    numericValue: value,
    source,
    confidence: 0.9,
    observedAt: createdAt,
    missing: false,
  })),
  graph: {
    version: 'entity-graph-v1.1',
    nodes: [
      { id: 'token:testq', type: 'token', label: 'TESTQ', attributes: { mint } },
      { id: 'x_account:research', type: 'x_account', label: '@research_x', attributes: {} },
      { id: 'tg_channel:alpha', type: 'tg_channel', label: '@alpha_research', attributes: {} },
      { id: 'wallet:smart-1', type: 'wallet', label: 'smart-wallet-1', attributes: { wash: false, smart: true, volumeSol: 18 } },
    ],
    edges: [
      { id: 'edge:x', source: 'x_account:research', target: 'token:testq', type: 'mentions', confidence: 0.82, evidenceIds: ['smoke-x-1'], attributes: { lagSeconds: 0 } },
      { id: 'edge:tg', source: 'tg_channel:alpha', target: 'token:testq', type: 'calls', confidence: 0.84, evidenceIds: ['smoke-tg-1'], attributes: { lagSeconds: 60 } },
      { id: 'edge:wallet', source: 'wallet:smart-1', target: 'token:testq', type: 'trades', confidence: 0.75, evidenceIds: [], attributes: { volumeSol: 18 } },
    ],
    stats: {
      nodes: 4,
      edges: 3,
      xAccounts: 1,
      tgChannels: 1,
      wallets: 1,
      bundles: 0,
      socialWalletLinks: 0,
      sharedLinks: 0,
      copyEdges: 0,
      amplificationEdges: 0,
    },
  },
  evidence: [
    { id: 'smoke-tg-1', platform: 'telegram', source: '@alpha_research', text: messages[0]!.text, timestamp: messages[0]!.sentAt, url: null },
    { id: 'smoke-tg-2', platform: 'telegram', source: '@sol_radar', text: messages[1]!.text, timestamp: messages[1]!.sentAt, url: null },
    { id: 'smoke-tg-3', platform: 'telegram', source: '@risk_desk', text: messages[2]!.text, timestamp: messages[2]!.sentAt, url: null },
    { id: 'smoke-x-1', platform: 'x', source: '@research_x', text: '$TESTQ discussion is growing, but no vertical breakout is assumed.', timestamp: '2026-09-13T12:05:00Z', url: null },
  ],
  rawSummary: {
    xPosts: 18,
    xRiskUniversePosts: 24,
    telegramMessages: messages.length,
    telegramMatchedBeforeLimit: messages.length,
    trades: 140,
    wallets: 36,
    bundles: 1,
    chainTruncated: false,
    marketAvailable: true,
    marketStale: false,
  },
});

const context = telegramContextSchema.parse({
  tokenAddress: mint,
  symbol: 'TESTQ',
  tokenName: 'Qwen Smoke Token',
  analysisMode: 'full_intelligence',
  analysisRole: 'analyst',
  windowStart: messages[0]!.sentAt,
  windowEnd: messages.at(-1)!.sentAt,
  intelligenceSnapshot: snapshot,
});

const result = telegramAiResultSchema.parse(mockTelegramAnalysis(messages, context));
const prompt = buildTelegramPrompt(messages, context);
const promptPayload = JSON.parse(prompt.user) as {
  context?: {
    analysisMode?: string;
    intelligenceSnapshot?: {
      features?: unknown[];
      graph?: { nodes?: unknown[]; edges?: unknown[] };
      evidence?: unknown[];
    };
  };
};

assert.equal(result.sentiment.label, 'mixed');
assert.equal(result.campaignHypothesis.label, 'organic');
assert.equal(result.coordinationSignals.length, 0);
assert.equal(result.entryAssessment?.priceState, 'reasonable_vs_signal');
assert.equal(result.entryAssessment?.entryAction, 'consider');
assert.match(result.entryAssessment?.oneLineVerdict ?? '', /можно рассматривать/i);
assert.match(result.sourceAssessments?.x.currentSituation ?? '', /72\/100/);
assert.match(result.sourceAssessments?.telegram.currentSituation ?? '', /3 Telegram-сообщений/);
assert.match(result.sourceAssessments?.chain.currentSituation ?? '', /36 кошельков и 140 трейдов/);
assert.ok(result.sourceAssessments?.x.supportingFeatureKeys.includes('scores.x'));
assert.ok(result.sourceAssessments?.telegram.supportingFeatureKeys.includes('scores.telegram'));
assert.ok(result.sourceAssessments?.chain.supportingFeatureKeys.includes('wallet.smart_activity'));
assert.equal(promptPayload.context?.analysisMode, 'full_intelligence');
assert.equal(promptPayload.context?.intelligenceSnapshot?.features?.length, features.length);
assert.equal(promptPayload.context?.intelligenceSnapshot?.graph?.nodes?.length, 4);
assert.equal(promptPayload.context?.intelligenceSnapshot?.graph?.edges?.length, 3);
assert.equal(promptPayload.context?.intelligenceSnapshot?.evidence?.length, 4);
assert.ok(prompt.user.length < 60_000, `Minimal Qwen smoke prompt is unexpectedly large: ${prompt.user.length}`);

console.log(JSON.stringify({
  status: 'ok',
  token: 'TESTQ',
  mint,
  snapshot: {
    features: snapshot.features.length,
    graphNodes: snapshot.graph.nodes.length,
    graphEdges: snapshot.graph.edges.length,
    evidence: snapshot.evidence.length,
    telegramMessages: snapshot.rawSummary.telegramMessages,
    xPosts: snapshot.rawSummary.xPosts,
    trades: snapshot.rawSummary.trades,
    wallets: snapshot.rawSummary.wallets,
  },
  result: {
    sentiment: result.sentiment,
    campaign: result.campaignHypothesis.label,
    coordinationSignals: result.coordinationSignals.length,
    entryAssessment: result.entryAssessment,
    sourceAssessments: result.sourceAssessments,
    finalIntelligence: result.finalIntelligence,
    overallConfidence: result.overallConfidence,
  },
  promptChars: prompt.user.length,
}, null, 2));
