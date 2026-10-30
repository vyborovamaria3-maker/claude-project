import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const route = read("app/api/trade/blockchain-ai-report/route.ts");
const panel = read("components/trade/BlockchainAiReportPanel.tsx");
const snapshot = read("lib/trade/chain/ai-snapshot.ts");
const guard = read("lib/trade/chain/ai-report-guard.ts");
assert(route.includes("evaluateBlockchainAiReport"));
assert(route.includes("MAX_REQUEST_BODY_BYTES = 4_096") && route.includes("readBoundedJson(req)"), "AI report request JSON must be size-bounded before parsing");
assert(route.includes('parsedBody.error === "too_large" ? 413 : 400'), "oversized AI report requests must be rejected with HTTP 413");
assert(!route.includes("req.json()"), "unbounded request JSON parsing must not return");
assert(!route.includes("upstreamMessage"), "upstream provider error bodies must not be logged");
assert(!route.includes('console.error("[blockchain-ai-report] failed", error)'), "raw exception objects must not be logged");
assert(route.includes('console.error("[blockchain-ai-report] failed")'), "failure logging must remain observable without raw details");
assert(route.includes("result.finalIntelligence.socialState"), "social-only AI output must count as report content");
assert(route.includes("body = record(await req.json())"), "non-object request bodies must be rejected");
assert(route.includes('if (!body) return NextResponse.json({ error: "invalid request body" }, { status: 400 });'));
assert(route.includes('typeof body.mint === "string"'), "mint must be a string before normalization");
assert(route.includes("usable: verification.usable"));
assert(route.includes("reportGuard: cached.guard"));
assert(panel.includes("AI reasoning guard"));
assert(panel.includes("effectiveConfidence01"));
assert(snapshot.includes("correlation/backtest association is not causality"));
assert(snapshot.includes("never claim the token is safe or risk-free"));
for (const code of [
  "funding_ownership_overclaim", "funding_insider_overclaim", "coordination_insider_overclaim", "coordination_ownership_overclaim",
  "jito_bundle_overclaim", "correlation_causality_overclaim", "observational_causality_overclaim", "confidence_probability_overclaim",
  "deterministic_future_prediction", "unknown_promoted_to_safe", "confidence_exceeds_evidence_cap", "contradictions_omitted",
  "unknowns_omitted", "transport_compaction_not_disclosed", "required_sections_missing",
  "unsupported_social_claim", "prompt_injection_artifact",
]) assert(guard.includes(`\"${code}\"`), `missing guard code ${code}`);
console.log("blockchain-ai-report-guard-regression: PASS");
