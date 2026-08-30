import assert from 'node:assert/strict';
import { buildTelegramPrompt, TELEGRAM_PROMPT_VERSION } from '@/server/telegram-ai/prompts.js';
import {
  intelligenceSnapshotSchema,
  telegramAiResultSchema,
  telegramContextSchema,
  telegramMessageSchema,
} from '@/server/telegram-ai/schemas.js';
import { groundMockFullIntelligence, validateTelegramAiResult } from '@/server/telegram-ai/validation.js';

const now = new Date().toISOString();
const message = telegramMessageSchema.parse({
  id: 'evidence-1', channelId: 'telegram:alpha', channelUsername: 'alpha', channelTitle: 'Alpha', senderId: null,
  text: '$TEST current call', sentAt: now, editedAt: null, views: 100, forwards: 5, reactions: 8, replyToMessageId: null, links: [],
});
const snapshot = intelligenceSnapshotSchema.parse({
  snapshotId: 'snapshot-entry-grounding', version: 'social-snapshot-v2', graphVersion: 'entity-graph-v1.1',
  mint: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump', symbol: 'TEST', tokenName: 'Test Token', createdAt: now,
  featureCount: 3, missingFeatureCount: 0,
  features: [
    { key: 'scores.social', group: 'Headline', label: 'Social score', value: 72, numericValue: 72, source: 'derived', confidence: 0.9, observedAt: now, missing: false },
    { key: 'scores.early', group: 'Headline', label: 'Early score', value: 61, numericValue: 61, source: 'derived', confidence: 0.8, observedAt: now, missing: false },
    { key: 'price_event_evidence.liquidity', group: 'Price', label: 'Liquidity', value: 250000, numericValue: 250000, source: 'market', confidence: 0.9, observedAt: now, missing: false },
  ],
  graph: {
    version: 'entity-graph-v1.1',
    nodes: [{ id: 'token:1', type: 'token', label: 'TEST', attributes: { mint: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump' } }],
    edges: [],
    stats: { nodes: 1, edges: 0, xAccounts: 0, tgChannels: 0, wallets: 0, bundles: 0, socialWalletLinks: 0, sharedLinks: 0, copyEdges: 0, amplificationEdges: 0 },
  },
  evidence: [{ id: 'evidence-1', platform: 'telegram', source: '@alpha', text: '$TEST current call', timestamp: now, url: null }],
  rawSummary: { xPosts: 0, telegramMessages: 1, trades: 0, wallets: 0, bundles: 0, chainTruncated: false, marketAvailable: true, marketStale: false },
});
const fullContext = telegramContextSchema.parse({ tokenAddress: snapshot.mint, symbol: snapshot.symbol, tokenName: snapshot.tokenName, analysisMode: 'full_intelligence', intelligenceSnapshot: snapshot });
const sourceAssessment = { currentSituation: 'Источник содержит ограниченный текущий сигнал.', interpretation: 'Сигнал оценивается только по переданным данным.', entryImpact: 'Источник сам по себе не определяет вход.', supportingFeatureKeys: [] as string[], confidence: 0.5 };
const baseResult = telegramAiResultSchema.parse({
  summary: 'Тестовый full-intelligence вывод.', sentiment: { label: 'neutral', score: 0, confidence: 0.5 }, dominantIntent: 'discussion',
  mentionedTokens: [], entities: [], claims: [], relationships: [], coordinationSignals: [],
  campaignHypothesis: { label: 'insufficient_data', confidence: 0.4, likelyOriginators: [], amplifiers: [], narrative: 'Недостаточно данных.', evidenceMessageIds: [] },
  risks: [],
  sourceAssessments: {
    x: { ...sourceAssessment, supportingFeatureKeys: ['scores.social'] },
    telegram: { ...sourceAssessment, supportingFeatureKeys: ['scores.social'] },
    chain: sourceAssessment,
  },
  entryAssessment: {
    priceState: 'reasonable_vs_signal', entryAction: 'wait_confirmation', oneLineVerdict: 'Нужно дождаться дополнительного подтверждения.',
    whyNow: ['Social-сигнал присутствует.'], alreadyPricedIn: [], missingConfirmation: ['Нужно on-chain подтверждение.'], invalidation: [],
    supportingFeatureKeys: ['scores.social'], evidenceMessageIds: ['evidence-1'], confidence: 0.55,
  },
  reasoningSummary: ['Вывод ограничен доступным покрытием.'], overallConfidence: 0.55,
});
assert.doesNotThrow(() => validateTelegramAiResult(baseResult, [message], fullContext));
const missingEntry = telegramAiResultSchema.parse({ ...baseResult, entryAssessment: undefined });
assert.throws(() => validateTelegramAiResult(missingEntry, [message], fullContext), /missing entryAssessment/);
const badSourceKey = telegramAiResultSchema.parse({ ...baseResult, sourceAssessments: { ...baseResult.sourceAssessments, x: { ...baseResult.sourceAssessments!.x, supportingFeatureKeys: ['not.visible.in.prompt'] } } });
assert.throws(() => validateTelegramAiResult(badSourceKey, [message], fullContext), /feature keys not present in its prompt/);
const badEntryKey = telegramAiResultSchema.parse({ ...baseResult, entryAssessment: { ...baseResult.entryAssessment!, supportingFeatureKeys: ['invented.entry.key'] } });
assert.throws(() => validateTelegramAiResult(badEntryKey, [message], fullContext), /feature keys not present in its prompt/);
const badEvidence = telegramAiResultSchema.parse({ ...baseResult, entryAssessment: { ...baseResult.entryAssessment!, evidenceMessageIds: ['ghost-evidence'] } });
assert.throws(() => validateTelegramAiResult(badEvidence, [message], fullContext), /unknown evidence IDs/);
const ungrounded = telegramAiResultSchema.parse({ ...baseResult, entryAssessment: { ...baseResult.entryAssessment!, supportingFeatureKeys: undefined, evidenceMessageIds: undefined } });
const grounded = groundMockFullIntelligence(ungrounded, fullContext);
assert.ok((grounded.entryAssessment?.supportingFeatureKeys?.length ?? 0) >= 1);
assert.doesNotThrow(() => validateTelegramAiResult(grounded, [message], fullContext));
assert.equal(TELEGRAM_PROMPT_VERSION, 'intelligence-qwen-v10-grounded-entry');
const analystPrompt = buildTelegramPrompt([message], fullContext);
assert.match(analystPrompt.system, /marketStale/);
assert.match(analystPrompt.user, /supportingFeatureKeys/);
const criticContext = telegramContextSchema.parse({ ...fullContext, analysisRole: 'critic', priorConclusion: JSON.stringify({ entryAssessment: baseResult.entryAssessment, sourceAssessments: baseResult.sourceAssessments }) });
const criticPrompt = buildTelegramPrompt([message], criticContext);
assert.match(criticPrompt.user, /entryAssessment/);
assert.match(criticPrompt.user, /sourceAssessments/);
assert.match(criticPrompt.user, /priorConclusion/);
console.log(JSON.stringify({ status: 'ok', promptVersion: TELEGRAM_PROMPT_VERSION, groundedEntryKeys: grounded.entryAssessment?.supportingFeatureKeys }, null, 2));
