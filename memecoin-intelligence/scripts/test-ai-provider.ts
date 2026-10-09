import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
let completionJson = '{}';
let failProvider = false;
let calls = 0;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end('{"status":"ok"}');
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer test-provider-key');
    if (failProvider) {
      res.statusCode = 503;
      return res.end('{"error":{"message":"fixture provider unavailable"}}');
    }
    return res.end(JSON.stringify({choices: [{ message: { content: completionJson } }],usage: { prompt_tokens: 100, completion_tokens: 50 }}));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
Object.assign(process.env, {
  NODE_ENV: 'test', TELEGRAM_AI_ENABLED: 'true', TELEGRAM_AI_MODE: 'openai-compatible',
  TELEGRAM_AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  TELEGRAM_AI_API_KEY: 'test-provider-key', TELEGRAM_AI_MODEL: 'fixture-model',
  TELEGRAM_AI_TIMEOUT_MS: '5000', TELEGRAM_AI_CACHE_SECONDS: '0',
});
try {
  const [{ telegramMessageSchema }, { mockTelegramAnalysis }, { runTelegramAi, qwenHealth }] = await Promise.all([
    import('@/server/telegram-ai/schemas.js'), import('@/server/telegram-ai/mock.js'),
    import('@/server/telegram-ai/qwenClient.js'),
  ]);
  const raw = JSON.parse(await readFile('fixtures/telegram-messages.json', 'utf8')) as unknown[];
  const messages = raw.map(message => telegramMessageSchema.parse(message));
  const context = {tokenAddress: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump',symbol: 'TEST',analysisMode: 'telegram_only' as const,analysisRole: 'analyst' as const};
  completionJson = JSON.stringify(mockTelegramAnalysis(messages, context));
  const health = await qwenHealth();
  assert.equal(health.reachable, true);
  assert.equal(health.model, 'fixture-model');
  const result = await runTelegramAi(messages, context, { bypassCache: true });
  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.model, 'fixture-model');
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.ok(calls >= 1);
  failProvider = true;
  await assert.rejects(runTelegramAi(messages, context, { bypassCache: true }));
  console.log('AI_PROVIDER_REGRESSION_OK: health, authentication, usage and failure propagation');
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
