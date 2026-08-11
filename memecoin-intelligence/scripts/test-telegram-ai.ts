import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mockTelegramAnalysis } from '@/server/telegram-ai/mock.js';
import { buildTelegramPrompt } from '@/server/telegram-ai/prompts.js';
import { intelligenceSnapshotSchema, telegramAiResultSchema, telegramContextSchema, telegramMessageSchema } from '@/server/telegram-ai/schemas.js';

const raw = JSON.parse(await readFile('fixtures/telegram-messages.json', 'utf8')) as unknown[];
const messages = raw.map((message) => telegramMessageSchema.parse(message));
const result = telegramAiResultSchema.parse(mockTelegramAnalysis(messages, {
  tokenAddress: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump',
  symbol: 'TEST',
}));

assert.equal(result.campaignHypothesis.label, 'coordinated');
assert.ok(result.coordinationSignals.some((signal) => signal.type === 'copied_text'));
assert.ok(result.coordinationSignals.some((signal) => signal.type === 'shared_links'));
assert.ok(result.mentionedTokens.some((token) => token.symbol === 'TEST'));
assert.ok(result.relationships.some((relationship) => relationship.type === 'copies'));
assert.ok(result.reasoningSummary.length >= 1);
assert.deepEqual(result.featureAssessments, []);
assert.deepEqual(result.discoveredRelationships, []);
assert.deepEqual(result.anomalies, []);

const now = new Date().toISOString();
const evidenceId = messages[0]?.id ?? 'message-1';
const snapshot = intelligenceSnapshotSchema.parse({
  snapshotId: 'snapshot-test',
  version: 'social-snapshot-v2',
  graphVersion: 'entity-graph-v1.1',
  mint: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump',
  symbol: 'TEST',
  tokenName: 'Test Token',
  createdAt: now,
  featureCount: 3,
  missingFeatureCount: 0,
  features: [
    { key: 'scores.social', group: 'Headline scores', label: 'Social score', value: 78, numericValue: 78, source: 'derived', confidence: 0.9, observedAt: now, missing: false },
    { key: 'scores.manipulation', group: 'Headline scores', label: 'Manipulation score', value: 42, numericValue: 42, source: 'derived', confidence: 0.9, observedAt: now, missing: false },
    { key: 'x.mentions_1h', group: 'X', label: 'Mentions 1h', value: '32', numericValue: 32, source: 'derived', confidence: 0.9, observedAt: now, missing: false },
  ],
  graph: {
    version: 'entity-graph-v1.1',
    nodes: [
      { id: 'token:1', type: 'token', label: 'TEST', attributes: { mint: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump' } },
      { id: 'tg_channel:1', type: 'tg_channel', label: '@alpha', attributes: {} },
      { id: 'wallet:1', type: 'wallet', label: 'wallet-one', attributes: { wash: false, volumeSol: 12 } },
      { id: 'bundle:1', type: 'bundle', label: 'Bundle 1', attributes: { size: 1 } },
    ],
    edges: [
      { id: 'edge:1', source: 'tg_channel:1', target: 'token:1', type: 'calls', confidence: 1, evidenceIds: [evidenceId], attributes: { lagSeconds: 0 } },
      { id: 'edge:2', source: 'wallet:1', target: 'token:1', type: 'trades', confidence: 1, evidenceIds: [], attributes: { volumeSol: 12 } },
      { id: 'edge:3', source: 'wallet:1', target: 'bundle:1', type: 'bundle_member', confidence: 1, evidenceIds: [], attributes: {} },
      { id: 'edge:4', source: 'tg_channel:1', target: 'wallet:1', type: 'mentions_wallet', confidence: 1, evidenceIds: [evidenceId], attributes: {} },
    ],
    stats: { nodes: 4, edges: 4, xAccounts: 0, tgChannels: 1, wallets: 1, bundles: 1, socialWalletLinks: 1, sharedLinks: 0, copyEdges: 0, amplificationEdges: 0 },
  },
  evidence: [
    { id: evidenceId, platform: 'telegram', source: '@alpha', text: 'TEST early call', timestamp: now, url: null },
  ],
  rawSummary: { xPosts: 0, telegramMessages: 1, trades: 100, wallets: 1, bundles: 1, chainTruncated: false, marketAvailable: true },
});

const fullContext = telegramContextSchema.parse({
  tokenAddress: snapshot.mint,
  symbol: snapshot.symbol,
  tokenName: snapshot.tokenName,
  analysisMode: 'full_intelligence',
  intelligenceSnapshot: snapshot,
});
const prompt = buildTelegramPrompt(messages, fullContext);
const parsedPrompt = JSON.parse(prompt.user) as {
  context?: { analysisMode?: string; intelligenceSnapshot?: { features?: Array<{ key?: string }>; graph?: { edges?: Array<{ type?: string }> } } };
};
assert.equal(parsedPrompt.context?.analysisMode, 'full_intelligence');
assert.deepEqual(parsedPrompt.context?.intelligenceSnapshot?.features?.map((feature) => feature.key), ['scores.social', 'scores.manipulation', 'x.mentions_1h']);
assert.equal(parsedPrompt.context?.intelligenceSnapshot?.graph?.edges?.length, 4);
assert.ok(parsedPrompt.context?.intelligenceSnapshot?.graph?.edges?.some((edge) => edge.type === 'mentions_wallet'));
assert.match(prompt.system, /adversarial critique/i);

console.log(JSON.stringify({
  status: 'ok',
  messages: messages.length,
  signals: result.coordinationSignals.length,
  relationships: result.relationships.length,
  hypothesis: result.campaignHypothesis.label,
  fullIntelligenceFeatures: snapshot.featureCount,
  fullIntelligenceGraphEdges: snapshot.graph.stats.edges,
  socialWalletLinks: snapshot.graph.stats.socialWalletLinks,
}, null, 2));
