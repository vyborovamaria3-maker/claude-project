import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseErrorTags } from "../lib/trade/error-report";

test("error report combines untrusted historical codes into a safe bucket", () => {
  const grouped = collapseErrorTags([
    {status:"failed",kind:"search",code:"[LEAK] token=secret",tasks:2},
    {status:"failed",kind:"search",code:"SENSITIVE_PASSWORD_123",tasks:3},
    {status:"failed",kind:"search",code:"LEGACY_OR_UNKNOWN",tasks:4},
    {status:"failed",kind:"search",code:"PROXY_AUTH",tasks:5},
  ]);
  assert.deepEqual(grouped, [
    {status:"failed",kind:"search",code:"LEGACY_OR_UNKNOWN",tasks:9},
    {status:"failed",kind:"search",code:"PROXY_AUTH",tasks:5},
  ]);
  assert.equal(JSON.stringify(grouped).includes("secret"),false);
});
