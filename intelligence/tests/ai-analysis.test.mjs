import test from "node:test";
import assert from "node:assert/strict";
import { createAiAnalysisService } from "../dist/index.js";
import { createAiGateway } from "@claude-project/ai-gateway";

const gateway = createAiGateway({
  providers: [{
    id: "primary", baseUrl: "https://api.example.test/v1", apiKey: "test-secret-key-123",
    chatModel: "chat-test", embeddingModel: "embed-test",
  }],
  defaultProviderId: "primary",
  fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === "embed-test") {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0.25) }], usage: { prompt_tokens: 2 } }));
    }
    const prompt = body.messages[1].content;
    if (prompt.includes('"alertType"')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        explanation: "Attention increased across the supplied sources.", evidenceRefs: ["x:tweet:1"],
      }) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      label: "bullish", score: 0.7, confidence: 0.8, evidenceRefs: ["tg:message:1"],
    }) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  },
});

function fakeTx(task = "sentiment", status = "active") {
  return {
    async query(sql, params) {
      if (sql.includes("FROM model_registry")) return { rows: [{
        model_id: params[0], provider: "primary", name: task === "embedding" ? "embed-test" : "chat-test",
        version: "1", task, status,
      }] };
      if (sql.includes("FROM token_alerts")) return { rows: [{ evidence_refs: ["tg:message:1", "x:tweet:1"] }] };
      if (sql.includes("INSERT INTO signal_explanations")) return { rows: [{ explanation_id: 1 }] };
      return { rows: [] };
    },
  };
}

test("AI analysis refuses unregistered/inactive models and validates provider output", async () => {
  await assert.rejects(createAiAnalysisService(fakeTx("sentiment", "shadow"), gateway)
    .analyzeSentiment({ modelId: "sentiment-v1", text: "launch" }), /registered, active/);
  const result = await createAiAnalysisService(fakeTx(), gateway)
    .analyzeSentiment({ modelId: "sentiment-v1", text: "launch", evidenceRefs: ["tg:message:1"] });
  assert.equal(result.label, "bullish");
  assert.equal(result.score, 0.7);
  assert.equal(result.evidenceRefs[0], "tg:message:1");
});

test("AI explanation cannot cite evidence that was not supplied", async () => {
  const service = createAiAnalysisService(fakeTx("explanation"), gateway);
  await assert.rejects(service.explainSignal({
    modelId: "explain-v1", alertId: 1, facts: { alertType: "attention_spike" }, evidenceRefs: ["tg:message:1"],
  }), /outside the supplied evidence set/);
});

test("signal explanations cannot attach evidence absent from the alert", async () => {
  const service=createAiAnalysisService(fakeTx("explanation"),gateway);
  await assert.rejects(service.saveSignalExplanation({alertId:1,modelId:"explain-v1",
    traceId:"00000000-0000-4000-8000-000000000001",explanation:"Validated explanation",evidenceRefs:["tg:message:999"]}),
    /not attached to alert/);
});

test("embedding output is checked for 1024 dimensions", async () => {
  const service = createAiAnalysisService(fakeTx("embedding"), gateway);
  const result = await service.embedText({
    modelId: "embed-v1", entityId: "solana:So11111111111111111111111111111111111111112",
    featureVersion: "features-v3", text: "narrative", asOf: "2026-10-22T00:00:00Z",
    maxInputObservedAt: "2026-10-21T23:59:00Z",
  });
  assert.equal(result.embedding.length, 1024);
});
