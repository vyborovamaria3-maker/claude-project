import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTickerMentions, fingerprintMessage, normalizeMessageForFingerprint } from "../src/analytics/token-intelligence.js";

test("cashtags are normalized, deduplicated and kept separate from token identity", () => {
  assert.deepEqual(extractTickerMentions("$BONK and $bonk; $WIF $TOOLONGTICKER123"), ["BONK", "WIF"]);
});

test("normalized fingerprints ignore changing mint, ticker, URL and handle values", () => {
  const first = "Early signal: buy $BONK now, inspect mint So11111111111111111111111111111111111111112, follow https://t.me/alpha_calls and contact @AlphaCalls for updates."; 
  const second = "Early signal: buy $WIF now, inspect mint 11111111111111111111111111111111, follow https://t.me/other_calls and contact @OtherCalls for updates."; 
  assert.equal(normalizeMessageForFingerprint(first), normalizeMessageForFingerprint(second));
  assert.equal(fingerprintMessage(first).fingerprint, fingerprintMessage(second).fingerprint);
  assert.equal(fingerprintMessage(first).clusterable, true);
});

test("short generic posts are not promoted into copy clusters", () => {
  assert.equal(fingerprintMessage("gm").clusterable, false);
  assert.equal(fingerprintMessage("buy now").clusterable, false);
});
