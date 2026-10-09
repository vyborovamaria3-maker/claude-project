import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

let completionJson = '{}';
let failTooken = false;
let tookenChatCalls = 0;
let qwenChatCalls = 0;

const server = createServer((req, res) => {
  const path = req.url || '/';
  res.setHeader('content-type', 'application/json');

  if (path === '/v1/models' && req.method === 'GET') {
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-chat-model', object: 'model' }, { id: 'image-test-model', object: 'model' }] }));
    return;
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    tookenChatCalls += 1;
    if (req.headers.authorization !== 'Bearer test-tooken-key') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'bad Tooken auth' } }));
      return;
    }
    if (failTooken) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { message: 'temporary Tooken failure' } }));
      return;
    }
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: completionJson } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
    return;
  }

  if (path === '/qwen/v1/chat/completions' && req.method === 'POST') {
    qwenChatCalls += 1;
    res.end(JSON.stringify({
      id: 'qwen-test',
      choices: [{ message: { role: 'assistant', content: completionJson } }],
      usage: { prompt_tokens: 90, completion_tokens: 45 },
    }));
    return;
  }

  if (path === '/qwen/health') {
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: `not found: ${path}` } }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('failed to bind test server');
const origin = `http://127.0.0.1:${address.port}`;

process.env.NODE_ENV = 'test';
process.env.TELEGRAM_AI_ENABLED = 'true';
process.env.TELEGRAM_AI_PROVIDER = 'tooken';
process.env.TELEGRAM_AI_FALLBACK_PROVIDER = 'qwen';
process.env.TOOKEN_BASE_URL = `${origin}/v1`;
process.env.TOOKEN_API_KEY = 'test-tooken-key';
process.env.TOOKEN_MODEL = '';
process.env.QWEN_BASE_URL = `${origin}/qwen/v1`;
process.env.QWEN_MODEL = 'Qwen/test-local';
process.env.TELEGRAM_AI_TIMEOUT_MS = '5000';
process.env.TELEGRAM_AI_MAX_TOKENS = '3200';

try {
  const [{ telegramMessageSchema }, { mockTelegramAnalysis }, { runTelegramAi, aiHealth }] = await Promise.all([
    import('@/server/telegram-ai/schemas.js'),
    import('@/server/telegram-ai/mock.js'),
    import('@/server/telegram-ai/qwenClient.js'),
  ]);

  const raw = JSON.parse(await readFile('fixtures/telegram-messages.json', 'utf8')) as unknown[];
  const messages = raw.map((message) => telegramMessageSchema.parse(message));
  const context = {
    tokenAddress: '3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump',
    symbol: 'TEST',
    analysisMode: 'telegram_only' as const,
    analysisRole: 'analyst' as const,
  };
  completionJson = JSON.stringify(mockTelegramAnalysis(messages, context));

  const health = await aiHealth();
  assert.equal(health.provider, 'tooken');
  assert.equal(health.reachable, true);
  assert.equal(health.model, 'test-chat-model');

  const primary = await runTelegramAi(messages, context, { bypassCache: true });
  assert.equal(primary.provider, 'tooken');
  assert.equal(primary.model, 'test-chat-model');
  assert.equal(primary.inputTokens, 100);
  assert.ok(tookenChatCalls >= 1);
  assert.equal(qwenChatCalls, 0);

  failTooken = true;
  const fallback = await runTelegramAi(messages, context, { bypassCache: true });
  assert.equal(fallback.provider, 'qwen');
  assert.equal(fallback.model, 'Qwen/test-local');
  assert.ok(qwenChatCalls >= 1);

  console.log(JSON.stringify({
    status: 'ok',
    primaryProvider: primary.provider,
    primaryModel: primary.model,
    fallbackProvider: fallback.provider,
    tookenChatCalls,
    qwenChatCalls,
  }, null, 2));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
