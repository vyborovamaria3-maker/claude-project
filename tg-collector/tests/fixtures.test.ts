import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Telegram fixture contract is versioned and contains no session material", async () => {
  const raw = await readFile(new URL("./fixtures/telegram/messages.v1.json", import.meta.url), "utf8");
  const fixture = JSON.parse(raw) as {
    fixture_version?: number;
    gramjs_version?: string;
    format?: string;
    messages?: Array<{ id?: number; message?: string }>;
  };
  assert.equal(fixture.fixture_version, 1);
  assert.equal(fixture.gramjs_version, "2.26.22");
  assert.equal(fixture.format, "json-message-envelope");
  assert.ok(Array.isArray(fixture.messages) && fixture.messages.length >= 3);
  for (const message of fixture.messages) {
    assert.ok(Number.isInteger(message.id) && (message.id ?? 0) > 0);
    assert.equal(typeof message.message, "string");
  }
  assert.doesNotMatch(raw, /(?:api_hash|apiHash|session|phone_code|auth_key|TG_API_HASH)/i);
});
