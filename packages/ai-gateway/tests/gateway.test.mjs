import test from "node:test";
import assert from "node:assert/strict";
import { createAiGateway, createAiGatewayFromEnv, AiGatewayError } from "../dist/index.js";

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
function provider(overrides = {}) {
  return {
    id: "primary",
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-secret-key-123",
    chatModel: "chat-test",
    embeddingModel: "embed-test",
    requestsPerMinute: 20,
    maxConcurrent: 2,
    ...overrides,
  };
}

test("chat completion uses configured API credentials without exposing them in results", async () => {
  let request;
  const gateway = createAiGateway({
    providers: [provider()],
    defaultProviderId: "primary",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return response({ choices: [{ message: { content: "{\"score\":0.4}" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    },
    now: () => 100,
  });
  const result = await gateway.chatCompletion({
    messages: [{ role: "system", content: "Return JSON." }, { role: "user", content: "Analyze this text." }],
    responseFormat: "json_object",
  });
  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer test-secret-key-123");
  assert.equal(result.content, "{\"score\":0.4}");
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 4);
  assert.ok(!JSON.stringify(result).includes("test-secret-key-123"));
});

test("embeddings validate vector dimensions and preserve provider ordering", async () => {
  const gateway = createAiGateway({
    providers: [provider()],
    defaultProviderId: "primary",
    fetchImpl: async () => response({
      data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
      usage: { prompt_tokens: 5 },
    }),
  });
  const result = await gateway.createEmbeddings({ texts: ["a", "b"], expectedDimensions: 2 });
  assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
  await assert.rejects(
    gateway.createEmbeddings({ texts: ["a"], expectedDimensions: 1024 }),
    (error) => error instanceof AiGatewayError && error.code === "ai_embedding_dimensions_mismatch",
  );
});

test("transient provider errors retry; authentication errors do not retry", async () => {
  let calls = 0;
  const gateway = createAiGateway({
    providers: [provider()],
    defaultProviderId: "primary",
    maxAttempts: 2,
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? response({ error: "unavailable" }, 503) :
        response({ choices: [{ message: { content: "ok" } }] });
    },
  });
  assert.equal((await gateway.chatCompletion({ messages: [{ role: "user", content: "hello" }] })).content, "ok");
  assert.equal(calls, 2);

  calls = 0;
  const unauthorized = createAiGateway({
    providers: [provider()],
    defaultProviderId: "primary",
    maxAttempts: 3,
    fetchImpl: async () => { calls++; return response({ error: "secret provider body" }, 401); },
  });
  await assert.rejects(
    unauthorized.chatCompletion({ messages: [{ role: "user", content: "hello" }] }),
    (error) => error instanceof AiGatewayError && error.code === "ai_provider_auth_failed",
  );
  assert.equal(calls, 1);
});

test("gateway enforces HTTPS, bounded inputs and provider rate limits", async () => {
  assert.throws(() => createAiGateway({
    providers: [provider({ baseUrl: "http://localhost:8000/v1" })],
    defaultProviderId: "primary",
  }), /ai_provider_url_must_be_https/);

  const gateway = createAiGateway({
    providers: [provider({ requestsPerMinute: 1, maxInputChars: 1000 })],
    defaultProviderId: "primary",
    now: () => 100,
    fetchImpl: async () => response({ choices: [{ message: { content: "ok" } }] }),
  });
  await gateway.chatCompletion({ messages: [{ role: "user", content: "first" }] });
  await assert.rejects(
    gateway.chatCompletion({ messages: [{ role: "user", content: "second" }] }),
    (error) => error instanceof AiGatewayError && error.code === "ai_provider_rate_limit_exhausted",
  );
  assert.throws(() => createAiGateway({
    providers: [provider({ maxInputChars: 1000 })],
    defaultProviderId: "primary",
  }).chatCompletion({ messages: [{ role: "user", content: "x".repeat(1001) }] }));
});

test("environment config resolves API keys from named variables, never from provider JSON", () => {
  assert.throws(() => createAiGatewayFromEnv({}), /ai_gateway_disabled/);
  assert.throws(() => createAiGatewayFromEnv({
    AI_GATEWAY_ENABLED: "true",
    AI_DEFAULT_PROVIDER: "primary",
    AI_PROVIDERS_JSON: '[{"id":"primary","baseUrl":"https://api.example.test/v1","apiKeyEnv":"PRIMARY_KEY","chatModel":"chat"}]',
  }), /ai_provider_api_key_missing/);
  assert.throws(() => createAiGatewayFromEnv({
    AI_GATEWAY_ENABLED: "true",
    AI_DEFAULT_PROVIDER: "primary",
    AI_PROVIDERS_JSON: '[{"id":"primary","baseUrl":"https://api.example.test/v1","apiKey":"do-not-allow","chatModel":"chat","apiKeyEnv":"PRIMARY_KEY"}]',
    PRIMARY_KEY: "test-secret-key-123",
  }), /ai_provider_config_must_reference_secret_env/);
  const gateway = createAiGatewayFromEnv({
    AI_GATEWAY_ENABLED: "true",
    AI_DEFAULT_PROVIDER: "primary",
    AI_PROVIDERS_JSON: '[{"id":"primary","baseUrl":"https://api.example.test/v1","apiKeyEnv":"PRIMARY_KEY","chatModel":"chat"}]',
    PRIMARY_KEY: "test-secret-key-123",
  }, { fetchImpl: async () => response({ choices: [{ message: { content: "ok" } }] }) });
  assert.equal((await gateway.chatCompletion({ messages: [{ role: "user", content: "hello" }] })).content, "ok");
});
