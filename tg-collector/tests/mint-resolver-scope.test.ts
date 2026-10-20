import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("TG RPC candidate reconciliation is version-scoped, retryable, and no secrets in errors",async()=>{
  // The main resolver is an opt-in CLI (import runs migrations). Inspect its
  // query contract offline; RPC response parsing has dedicated executable tests.
  const source=await readFile(new URL(
    "../src/analytics/resolve-token-candidates.ts",import.meta.url),"utf8");
  assert.match(source,/readMintAccount.*solana-mint-rpc/);
  assert.match(source,/analysis_version=\$3/);
  assert.match(source,/resolution_status IN \('unresolved','ambiguous'\)/);
  assert.match(source,/checked_at IS NULL OR checked_at < now\(\) - interval '24 hours'/);
  assert.doesNotMatch(source,/SET resolution_status='not_token'/);
  assert.doesNotMatch(source,/error\.message\s*:\s*String\(error\)/);
  assert.match(source,/provider_unavailable_or_invalid/);
});
