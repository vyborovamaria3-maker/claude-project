import assert from "node:assert/strict";
import { test } from "node:test";
import { searchFailureMessage } from "../lib/trade/search-diagnostics";
import { taskFailure } from "../lib/trade/task-errors";

test("search diagnostics distinguish unparsed articles from missing timeline", () => {
  const malformed = searchFailureMessage({ articleNodes: 4, errorBanner: false, loading: false });
  assert.match(malformed, /^SEARCH_PARSE_UNCONFIRMED/);
  assert.equal(taskFailure(new Error(malformed)).code, "SEARCH_PARSE_UNCONFIRMED");

  const unloaded = searchFailureMessage({ articleNodes: 0, errorBanner: true, loading: true });
  assert.match(unloaded, /^SEARCH_UNCONFIRMED/);
  assert.match(unloaded, /errorBanner=true; loading=true/);
  assert.equal(taskFailure(new Error(unloaded)).code, "SEARCH_UNCONFIRMED");
  assert.match(searchFailureMessage(null), /inspection=unavailable/);
});

test("search diagnostics never include body text, request URL or authentication tokens", () => {
  const message = searchFailureMessage({ articleNodes: 0, errorBanner: false, loading: false });
  assert(!message.includes("auth_token"));
  assert(!message.includes("rawQuery"));
});

test("unconfirmed timeline cannot be treated as proof of account restriction", () => {
  const missing = searchFailureMessage({ articleNodes: 0, errorBanner: false, loading: true })
    .replace(/^SEARCH_/, "TIMELINE_");
  const unparsed = searchFailureMessage({ articleNodes: 5, errorBanner: false, loading: false })
    .replace(/^SEARCH_/, "TIMELINE_");
  assert.equal(taskFailure(new Error(missing)).code, "TIMELINE_UNCONFIRMED");
  assert.equal(taskFailure(new Error(unparsed)).code, "TIMELINE_PARSE_UNCONFIRMED");
  assert.equal(taskFailure(new Error(missing)).permanent, false);
  assert.equal(taskFailure(new Error(unparsed)).permanent, false);
});
