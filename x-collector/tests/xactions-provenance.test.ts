import assert from "node:assert/strict";
import test from "node:test";
import { sourceId } from "../lib/archive/store";

test("HTTP and browser observations cannot share an archive source identity", () => {
  const browser = sourceId("https://x.com", "X platform terms", "x");
  const http = sourceId("https://x.com/i/api/graphql", "X platform terms", "x");
  assert.notEqual(browser, http);
  assert.match(browser, /^[0-9a-f]{64}$/);
  assert.match(http, /^[0-9a-f]{64}$/);
});
