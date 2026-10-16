import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { guardTgCollector, resetTgCollectorRateLimitForTests } from "../lib/tgCollectorAccess.ts";

const makeRequest = (token?: string, ip = "127.0.0.1", mutation = false) => {
  const url = new URL("http://127.0.0.1:3171/api/integrations/tg-collector");
  const headers = new Headers({ host: "127.0.0.1:3171", "x-forwarded-for": ip });
  if (token) headers.set("authorization", "Bearer " + token);
  if (mutation) headers.set("origin", url.origin);
  return new NextRequest(url, { headers, method: mutation ? "POST" : "GET" });
};

test("TG Collector access rejects missing token", () => {
  resetTgCollectorRateLimitForTests();
  process.env.NODE_ENV = "development";
  process.env.TG_COLLECTOR_ADMIN_TOKEN = "local-browser-fixture-access-key";
  const response = guardTgCollector(makeRequest());
  assert.equal(response?.status, 401);
});

test("TG Collector access rejects wrong token", () => {
  resetTgCollectorRateLimitForTests();
  process.env.NODE_ENV = "development";
  process.env.TG_COLLECTOR_ADMIN_TOKEN = "local-browser-fixture-access-key";
  const response = guardTgCollector(makeRequest("wrong-token"));
  assert.equal(response?.status, 401);
});

test("TG Collector access accepts correct token", () => {
  resetTgCollectorRateLimitForTests();
  process.env.NODE_ENV = "development";
  process.env.TG_COLLECTOR_ADMIN_TOKEN = "local-browser-fixture-access-key";
  const response = guardTgCollector(makeRequest("local-browser-fixture-access-key"));
  assert.equal(response, null);
});

test("TG Collector access rate-limits abusive callers", () => {
  resetTgCollectorRateLimitForTests();
  process.env.NODE_ENV = "development";
  process.env.TG_COLLECTOR_ADMIN_TOKEN = "local-browser-fixture-access-key";
  let response: Response | null = null;
  for (let i = 0; i < 121; i += 1) {
    response = guardTgCollector(makeRequest("local-browser-fixture-access-key", "127.0.0.2"));
  }
  assert.equal(response?.status, 429);
});
