import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTgCollectorAccess,
  resetTgCollectorRateLimitForTests,
} from "../lib/tgCollectorAccessCore.ts";

const secret = "local-browser-fixture-access-key";
const input = (token = "", ip = "127.0.0.1", mutation = false) => ({
  hostname: "127.0.0.1",
  hostHeader: "127.0.0.1:3171",
  origin: mutation ? "http://127.0.0.1:3171" : null,
  requestOrigin: "http://127.0.0.1:3171",
  mutation,
  providedToken: token,
  secret,
  production: false,
  clientAddress: ip,
});

test("TG Collector access rejects missing token", () => {
  resetTgCollectorRateLimitForTests();
  assert.equal(checkTgCollectorAccess(input()).status, 401);
});

test("TG Collector access rejects wrong token", () => {
  resetTgCollectorRateLimitForTests();
  assert.equal(checkTgCollectorAccess(input("wrong-token")).status, 401);
});

test("TG Collector access accepts correct token", () => {
  resetTgCollectorRateLimitForTests();
  assert.deepEqual(checkTgCollectorAccess(input(secret)), { ok: true });
});

test("TG Collector mutations require same-origin", () => {
  resetTgCollectorRateLimitForTests();
  const request = input(secret, "127.0.0.3", true);
  request.origin = "http://evil.invalid";
  assert.equal(checkTgCollectorAccess(request).status, 403);
});

test("TG Collector access rate-limits abusive callers", () => {
  resetTgCollectorRateLimitForTests();
  let result = checkTgCollectorAccess(input(secret, "127.0.0.2"));
  for (let i = 1; i < 121; i += 1) {
    result = checkTgCollectorAccess(input(secret, "127.0.0.2"));
  }
  assert.equal(result.status, 429);
});
