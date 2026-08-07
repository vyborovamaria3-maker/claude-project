import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mockTelegramAnalysis } from '@/server/telegram-ai/mock.js';
import { telegramAiResultSchema, telegramMessageSchema } from '@/server/telegram-ai/schemas.js';

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
console.log(JSON.stringify({ status: 'ok', messages: messages.length, signals: result.coordinationSignals.length, relationships: result.relationships.length, hypothesis: result.campaignHypothesis.label }, null, 2));
