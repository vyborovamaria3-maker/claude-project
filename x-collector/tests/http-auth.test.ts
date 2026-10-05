import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBasicAuth, parseBasicAuth, isLoopbackHost } from "../lib/trade/http-auth";
import { advisoryKey } from "../lib/trade/advisory";

const basic = (pair: string) => "Basic " + Buffer.from(pair, "utf8").toString("base64");

test("checkBasicAuth: корректный и некорректный ввод", () => {
  assert.equal(checkBasicAuth(basic("user:pass"), "user", "pass"), "ok");
  assert.equal(checkBasicAuth(basic("user:wrong"), "user", "pass"), "invalid");
  assert.equal(checkBasicAuth(basic("wrong:pass"), "user", "pass"), "invalid");
  assert.equal(checkBasicAuth(undefined, "user", "pass"), "missing");
  assert.equal(checkBasicAuth("Bearer xyz", "user", "pass"), "missing");
  assert.equal(checkBasicAuth(basic("no-colon"), "user", "pass"), "missing");
});

test("checkBasicAuth: без настроенных кредов — всегда ok", () => {
  assert.equal(checkBasicAuth(undefined, undefined, undefined), "ok");
});

test("parseBasicAuth: пароль может содержать двоеточия", () => {
  const parsed = parseBasicAuth(basic("user:pa:ss"));
  assert.deepEqual(parsed, { user: "user", pass: "pa:ss" });
});

test("isLoopbackHost", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test("advisoryKey: стабилен и помещается в int4", () => {
  const a = advisoryKey("x-collector:scheduler:pagerank");
  assert.equal(a, advisoryKey("x-collector:scheduler:pagerank"));
  assert.notEqual(a, advisoryKey("x-collector:scheduler:clusters"));
  assert.ok(Number.isInteger(a));
  assert.ok(a >= -2147483648 && a <= 2147483647);
});
