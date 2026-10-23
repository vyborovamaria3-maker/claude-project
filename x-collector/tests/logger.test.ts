import test from "node:test";
import assert from "node:assert/strict";
import { scrub, redactText } from "../lib/trade/logger";
test('error text redacts connection credentials and authorization',()=>{
  const safe=redactText('postgresql://alice:password@localhost/db Bearer abcdef auth_token=secret');
  assert(!safe.includes('password')); assert(!safe.includes('abcdef')); assert(!safe.includes('secret'));
});

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
  assert.equal(result.credentials, "[REDACTED]");
  assert.equal(scrub("http://user:pass@host", "proxy"), "[REDACTED]");
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

test('text scrubbing consumes JSON, quoted, multiline and keyring secrets completely',()=>{
 const marker='synthetic-canary-do-not-log';
 for(const text of [
  `MASTER_KEY=${marker}`,`X_COLLECTOR_MASTER_KEY="${marker} second word"`,
  JSON.stringify({password:marker+' second word',ct0:marker}),
  'X_COLLECTOR_ENCRYPTION_KEYS='+JSON.stringify({future:marker,nested:{key:marker}}),
  `X_COLLECTOR_ENCRYPTION_KEYS={\n"future":"${marker}"\n}`,
  `https://provider.invalid/?api_key=${marker}&access_token=${marker}`,
  `cookies=[{"name":"ct0","value":"${marker}"}]`,
  `session='${marker} unfinished`,
 ])assert(!redactText(text).includes(marker),'A complete synthetic secret must be removed');
 assert.equal((scrub({ct0:marker}) as {ct0:string}).ct0,'[REDACTED]');
 assert.equal(scrub(Buffer.from(marker)),'[BINARY_REDACTED]');
 assert.equal(scrub(new Uint8Array([1,2,3])),'[BINARY_REDACTED]');
 assert.equal(redactText('taskId=42 status=failed'),'taskId=42 status=failed');
});
