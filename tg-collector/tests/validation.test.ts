import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePublicUsername, telegramWaitSeconds } from "../src/validation.js";

test("public username normalized from @handle and t.me URL", () => {
  assert.equal(normalizePublicUsername("@Solana_Alpha"), "solana_alpha");
  assert.equal(normalizePublicUsername("https://t.me/solana_alpha/123"), "solana_alpha");
  assert.equal(normalizePublicUsername("https://www.telegram.me/solana_alpha"), "solana_alpha");
});
test("rejects invite links, invalid usernames, and profile paths", () => {
  for (const input of ["", "a", "https://t.me/+abc123", "https://t.me/joinchat/ABC123", "foo bar", "https://evil.example/abcd"]) {
    assert.throws(() => normalizePublicUsername(input));
  }
});
test("parses Telegram FloodWait from object or message", () => {
  assert.equal(telegramWaitSeconds({ seconds: 23 }), 23);
  assert.equal(telegramWaitSeconds(new Error("FLOOD_WAIT_120")), 120);
  assert.equal(telegramWaitSeconds(new Error("network failed")), null);
  assert.equal(telegramWaitSeconds({ seconds: 0 }), null);
});
