import test from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../lib/trade/logger";

test("scrub redacts token/password/secret/session/cookie/api key fields", () => {
  assert.equal(scrub("abc", "botToken"), "[REDACTED]");
  assert.equal(scrub("abc", "password"), "[REDACTED]");
  assert.equal(scrub("abc", "session"), "[REDACTED]");
  assert.equal(scrub("abc", "cookie"), "[REDACTED]");
  assert.equal(scrub("abc", "authorization"), "[REDACTED]");
  assert.equal(scrub("abc", "masterKey"), "[REDACTED]");
  assert.equal(scrub("abc", "api_key"), "[REDACTED]");
});

test("scrub redacts nested secret fields inside objects and arrays", () => {
  const result = scrub({
    handle: "alice",
    credentials: { botToken: "leak", nested: { password: "leak2" } },
    list: [{ secret: "leak3" }],
  }) as Record<string, unknown>;
  assert.equal(result.handle, "alice");
  assert.deepEqual(result.credentials, { botToken: "[REDACTED]", nested: { password: "[REDACTED]" } });
  assert.deepEqual(result.list, [{ secret: "[REDACTED]" }]);
});

test("scrub truncates very long strings", () => {
  const long = "x".repeat(25_000);
  const out = scrub(long) as string;
  assert.ok(out.length < long.length);
  assert.match(out, /\[TRUNCATED\]/);
});

test("scrub caps recursion depth", () => {
  let nested: Record<string, unknown> = { value: "bottom" };
  for (let i = 0; i < 10; i++) nested = { child: nested };
  const json = JSON.stringify(scrub(nested));
  assert.match(json, /\[DEPTH_LIMIT\]/);
});
