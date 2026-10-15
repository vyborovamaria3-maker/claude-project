import assert from "node:assert/strict";
import { test } from "node:test";
import * as collector from "../src/collector";
import { pickAccount as legacyPick, proxyConnectionIdentity } from "../lib/trade/account-manager";
import { claimTasks as legacyClaim } from "../lib/trade/tasks";
import { searchTweets as legacySearch } from "../lib/trade/twitter-scraper";
import { persistTweets as legacyPersist } from "../lib/trade/collector-store";
import { liveSnapshot as legacyLive } from "../lib/collector/live";
import { executeTask as legacyExecute } from "../src/runtime/collector-task";
import { waitForDatabaseRecovery as legacyRecover } from "../src/runtime/db-recovery";
import { safeLastErrorCode as legacyStatus } from "../lib/trade/task-status";

test("six collector modules preserve entrypoint identity and runtime singleton behavior", () => {
  assert.equal(collector.accounts.pickAccount, legacyPick);
  assert.equal(collector.accounts.proxyConnectionIdentity, proxyConnectionIdentity);
  assert.equal(collector.queue.claimTasks, legacyClaim);
  assert.equal(collector.queue.safeLastErrorCode, legacyStatus);
  assert.equal(collector.engines.searchTweets, legacySearch);
  assert.equal(collector.persistence.persistTweets, legacyPersist);
  assert.equal(collector.monitoring.liveSnapshot, legacyLive);
  assert.equal(collector.runtime.executeTask, legacyExecute);
  assert.equal(collector.runtime.waitForDatabaseRecovery, legacyRecover);
});

test("subsystem boundaries keep retry diagnostics safe and proxy identity canonical", () => {
  const a = JSON.stringify({type:"socks5",host:"proxy.local",port:1080,latency:150,last_check:10});
  const b = JSON.stringify({type:"socks5",host:"proxy.local",port:1080,latency:250,last_check:20});
  assert.equal(collector.accounts.proxyConnectionIdentity(a), collector.accounts.proxyConnectionIdentity(b));
  assert.notEqual(
    collector.accounts.proxyConnectionIdentity(a),
    collector.accounts.proxyConnectionIdentity(JSON.stringify({type:"socks5",host:"proxy.local",port:1080,username:"different"})),
  );
  assert.equal(collector.queue.safeLastErrorCode("[SENSITIVE_TOKEN] token=secret"),"LEGACY_OR_UNKNOWN");
  assert.equal(collector.monitoring.collapseErrorTags([{status:"failed",kind:"search",code:"SENSITIVE_TOKEN",tasks:2}])[0].code,"LEGACY_OR_UNKNOWN");
});
