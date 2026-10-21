import assert from "node:assert/strict";
import { test } from "node:test";
import * as collector from "../src/collector";

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
