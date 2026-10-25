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

test("provider requests forbid redirects and cancel rejected response streams",async()=>{
  let cancelled=0;
  const gateway=createAiGateway({providers:[provider()],defaultProviderId:"primary",maxAttempts:2,
    sleep:async()=>{},fetchImpl:async(_url,init)=>{
      assert.equal(init.redirect,"error");
      return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:503});
    }});
  await assert.rejects(gateway.chatCompletion({messages:[{role:"user",content:"hello"}]}),
    error=>error.code==="ai_provider_http_error");
  assert.equal(cancelled,2);
});

test("provider responses enforce byte limits with and without content-length",async()=>{
  for(const declared of [true,false]){
    let cancelled=false;
    const gateway=createAiGateway({providers:[provider()],defaultProviderId:"primary",
      fetchImpl:async()=>new Response(new ReadableStream({
        start(controller){if(!declared)controller.enqueue(new Uint8Array(16*1024*1024+1));},
        cancel(){cancelled=true;},
      }),{headers:declared?{"content-length":String(16*1024*1024+1)}:{}})});
    await assert.rejects(gateway.chatCompletion({messages:[{role:"user",content:"hello"}]}),
      error=>error.code==="ai_provider_response_too_large");
    assert.equal(cancelled,true);
    assert.equal(gateway.getMetrics()[0].inFlight,0);
  }
});

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
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return response({
        data: body.input.length === 1 ? [{ index: 0, embedding: [1, 0] }] : [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
        usage: { prompt_tokens: 5 },
      });
    },
  });
  const result = await gateway.createEmbeddings({ texts: ["a", "b"], expectedDimensions: 2 });
  assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
  await assert.rejects(
    gateway.createEmbeddings({ texts: ["a"], expectedDimensions: 1024 }),
    (error) => error instanceof AiGatewayError && error.code === "ai_embedding_dimensions_mismatch",
  );
});

test("embeddings bill actual prompt token usage instead of a character estimate", async () => {
  const gateway=createAiGateway({providers:[provider({inputCostPer1kUsd:0.02,outputCostPer1kUsd:0.05,
    maxEstimatedCostUsd:0.2})],defaultProviderId:"primary",
    fetchImpl:async()=>response({data:[{index:0,embedding:[1,0]}],usage:{prompt_tokens:100}})});
  const result=await gateway.createEmbeddings({texts:["hello"],expectedDimensions:2});
  assert.ok(Math.abs(result.estimatedCostUsd-0.002)<1e-12);
  assert.ok(Math.abs(gateway.getMetrics()[0].estimatedCostUsd-0.002)<1e-12);
});

test("embeddings reject missing and duplicate indices instead of returning sparse vectors", async () => {
  for (const data of [[{index:0,embedding:[1,0]}],[{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}]]) {
    const gateway=createAiGateway({providers:[provider()],defaultProviderId:"primary",fetchImpl:async()=>response({data,usage:{prompt_tokens:2}})});
    await assert.rejects(gateway.createEmbeddings({texts:["a","b"],expectedDimensions:2}),
      (error)=>error instanceof AiGatewayError&&error.code==="ai_embedding_response_invalid");
  }
});

test("concurrent requests reserve estimated provider budget before yielding", async () => {
  let calls=0,markStarted,release;
  const started=new Promise(resolve=>{markStarted=resolve;}), blocked=new Promise(resolve=>{release=resolve;});
  const gateway=createAiGateway({providers:[provider({inputCostPer1kUsd:1,outputCostPer1kUsd:1,maxEstimatedCostUsd:12,maxConcurrent:2})],
    defaultProviderId:"primary",fetchImpl:async()=>{calls++;markStarted();await blocked;return response({choices:[{message:{content:"ok"}}],usage:{prompt_tokens:2,completion_tokens:1}});}});
  const first=gateway.chatCompletion({messages:[{role:"user",content:"hello"}],maxTokens:1}); await started;
  await assert.rejects(gateway.chatCompletion({messages:[{role:"user",content:"hello"}],maxTokens:1}),
    error=>error instanceof AiGatewayError&&error.code==="ai_provider_cost_budget_exhausted");
  release(); await first; assert.equal(calls,1); assert.equal(gateway.getMetrics()[0].reservedCostUsd,0);
});

test("uncertain failures retain their allowance and each retry must fit the remaining budget", async () => {
  for (const fail of [async()=>{throw new Error("timeout after remote billing");},
    async()=>response({error:"unavailable"},503),async()=>new Response("invalid json")]) {
    let calls=0;
    const gateway=createAiGateway({providers:[provider({inputCostPer1kUsd:1,outputCostPer1kUsd:1,
      maxEstimatedCostUsd:12})],defaultProviderId:"primary",maxAttempts:2,sleep:async()=>{},
      fetchImpl:async()=>{calls++;return fail();}});
    await assert.rejects(gateway.chatCompletion({messages:[{role:"user",content:"hello"}],maxTokens:1}));
    assert.equal(calls,1,"a retry cannot reuse the failed attempt's allowance");
    await assert.rejects(gateway.chatCompletion({messages:[{role:"user",content:"hello"}],maxTokens:1}),
      error=>error.code==="ai_provider_cost_budget_exhausted");
    assert.equal(calls,1);assert.equal(gateway.getMetrics()[0].reservedCostUsd,0);
    assert.ok(gateway.getMetrics()[0].estimatedCostUsd>8);
  }
});

test("multilingual prompts reserve UTF-8 bytes and protocol overhead before sending",async()=>{
  let calls=0;
  const gateway=createAiGateway({providers:[provider({inputCostPer1kUsd:1,outputCostPer1kUsd:1,
    maxEstimatedCostUsd:9})],defaultProviderId:"primary",fetchImpl:async()=>{calls++;throw new Error("must not send");}});
  await assert.rejects(gateway.chatCompletion({messages:[{role:"user",content:"界".repeat(1000)}],maxTokens:1}),
    error=>error.code==="ai_provider_cost_budget_exhausted");
  assert.equal(calls,0);
});

test("metric callback failures do not turn successful provider calls into failures", async () => {
  const gateway=createAiGateway({providers:[provider()],defaultProviderId:"primary",onMetric:()=>{throw new Error("telemetry down");},
    fetchImpl:async()=>response({choices:[{message:{content:"ok"}}]})});
  assert.equal((await gateway.chatCompletion({messages:[{role:"user",content:"hello"}]})).content,"ok");
  assert.equal(gateway.getMetrics()[0].successfulRequests,1); assert.equal(gateway.getMetrics()[0].failedRequests,0);
});

test("embeddings reject sparse text input arrays", async () => {
  const gateway=createAiGateway({providers:[provider()],defaultProviderId:"primary",fetchImpl:async()=>response({data:[]})});
  const texts=new Array(2); texts[0]="hello";
  await assert.rejects(gateway.createEmbeddings({texts}),
    error=>error instanceof AiGatewayError&&error.code==="ai_embedding_input_invalid");
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
  await assert.rejects(createAiGateway({
    providers: [provider({ maxInputChars: 1000 })],
    defaultProviderId: "primary",
  }).chatCompletion({ messages: [{ role: "user", content: "x".repeat(1001) }] }), /ai_input_too_large/);
});

test("environment config resolves API keys from named variables, never from provider JSON", async () => {
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
