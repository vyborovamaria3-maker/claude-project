import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveTaskDisplayState, safeLastErrorCode } from "../lib/trade/task-status";

test("task display statuses distinguish waiting account, retry, partial and running", () => {
  const base = { status: "pending", availableAt: 2000, now: 1000 };
  assert.equal(deriveTaskDisplayState(base), "retry_wait");
  assert.equal(deriveTaskDisplayState({ ...base, phase: "waiting", lastError: "no available account; waiting for lease or quota" }), "waiting_account");
  assert.equal(deriveTaskDisplayState({ ...base, hasPartialCheckpoint: true }), "partial");
  assert.equal(deriveTaskDisplayState({ ...base, status: "claimed", hasPartialCheckpoint: true }), "running");
  assert.equal(deriveTaskDisplayState({ ...base, status: "done" }), "completed");
  assert.equal(deriveTaskDisplayState({ ...base, status: "failed" }), "failed");
  assert.equal(deriveTaskDisplayState({ ...base, availableAt: 0 }), "queued");
});

test("task status reporting only emits allowlisted symbolic error markers", () => {
  assert.equal(safeLastErrorCode("[SEARCH_UNCONFIRMED] failed account token=secret"), "SEARCH_UNCONFIRMED");
  assert.equal(safeLastErrorCode("no available account; waiting for lease or quota"), "WAITING_ACCOUNT");
  assert.equal(safeLastErrorCode("XActions account HTTP quota exhausted"), "ACCOUNT_QUOTA_WAIT");
  assert.equal(safeLastErrorCode("token=secret password=secret"), "LEGACY_OR_UNKNOWN");
  assert.equal(safeLastErrorCode("[AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA] raw secret"), "LEGACY_OR_UNKNOWN");
  assert.equal(safeLastErrorCode(null), null);
});
