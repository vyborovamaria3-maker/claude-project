import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Regression coverage for the npm-audit policy gate: explicit, time-bounded,
// logged exceptions (bigint-buffer, unfixed picomatch ReDoS) must never hide
// any other high/critical advisory, must fail closed when their acceptance
// window is missing or expired, and must stay visible in the output.
const policy = path.join(path.dirname(fileURLToPath(import.meta.url)), "npm-audit-policy.mjs");

function auditJson(entries) {
  return JSON.stringify({
    vulnerabilities: Object.fromEntries(entries.map(([name, severity, via]) => [name, {
      severity,
      via,
      effects: [],
    }])),
  });
}

function runPolicy(report, env) {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-policy-"));
  const file = path.join(dir, "audit.json");
  writeFileSync(file, report, "utf8");
  try {
    const result = spawnSync(process.execPath, [policy, file], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const picomatchVia = [{
  severity: "high",
  name: "picomatch",
  title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
}];
const bigintVia = [{
  severity: "high",
  name: "bigint-buffer",
  title: "bigint-buffer vulnerable to buffer overflow",
  url: "https://github.com/advisories/GHSA-3gc7-fjrx-p6mg",
}];
const unknownVia = [{
  severity: "high",
  name: "something-else",
  title: "unrelated critical advisory",
  url: "https://github.com/advisories/GHSA-0000-0000-0000",
}];
const env = {
  ALLOW_BIGINT_BUFFER_UNTIL: "2099-01-01",
  ALLOW_PICOMATCH_UNTIL: "2099-01-01",
};

test("policy allows only the documented exceptions and logs the acceptance", () => {
  const result = runPolicy(auditJson([
    ["picomatch", "high", picomatchVia],
    ["bigint-buffer", "high", bigintVia],
  ]), env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /NPM_AUDIT_POLICY_ALLOWLIST GHSA-fc5q-39xc-vjpf/);
  assert.match(result.stdout + result.stderr, /NPM_AUDIT_POLICY_EXCEPTION GHSA-fc5q-39xc-vjpf/);
  assert.match(result.stdout, /NPM_AUDIT_POLICY_OK/);
});

test("policy fails closed on any unexpected high advisory", () => {
  const result = runPolicy(auditJson([
    ["picomatch", "high", picomatchVia],
    ["some-package", "high", unknownVia],
  ]), env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NPM_AUDIT_POLICY_FAIL unexpected high\/critical advisories/);
  assert.match(result.stderr, /some-package/);
});

test("policy fails closed without an acceptance window", () => {
  const result = runPolicy(auditJson([["picomatch", "high", picomatchVia]]), {
    ALLOW_BIGINT_BUFFER_UNTIL: "2099-01-01",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALLOW_PICOMATCH_UNTIL=YYYY-MM-DD is required/);
});

test("policy fails closed when the acceptance window has expired", () => {
  const result = runPolicy(auditJson([["picomatch", "high", picomatchVia]]), {
    ALLOW_BIGINT_BUFFER_UNTIL: "2099-01-01",
    ALLOW_PICOMATCH_UNTIL: "2026-01-01",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /picomatch ReDoS exception expired/);
});

test("policy fails closed when the npm report lacks the vulnerabilities object", () => {
  const result = runPolicy(JSON.stringify({ error: { summary: "broken lockfile" } }), env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not contain a vulnerabilities object/);
});

test("policy fails closed on a different picomatch advisory id (strict citation)", () => {
  const otherPicomatchVia = [{ ...picomatchVia[0], url: "https://github.com/advisories/GHSA-fake-different", title: "some other picomatch ReDoS variant" }];
  const result = runPolicy(auditJson([["picomatch", "high", otherPicomatchVia]]), env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NPM_AUDIT_POLICY_FAIL unexpected high\/critical advisories/);
});

test("policy fails closed when a severe finding has no resolvable advisory object", () => {
  const result = runPolicy(auditJson([["mystery-package", "high", ["indirect"]]]), {
    ALLOW_BIGINT_BUFFER_UNTIL: "2099-01-01",
  });
  assert.notEqual(result.status, 0);
});
