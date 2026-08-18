#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node npm-audit-policy.mjs <npm-audit.json>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`Unable to parse npm audit JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const vulnerabilities = report?.vulnerabilities ?? {};
const highOrCritical = Object.entries(vulnerabilities).filter(([, value]) =>
  value && (value.severity === 'high' || value.severity === 'critical')
);

if (highOrCritical.length === 0) {
  console.log('NPM_AUDIT_POLICY_OK no high/critical vulnerabilities');
  process.exit(0);
}

const advisoryObjects = [];
for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
  if (!vulnerability || !Array.isArray(vulnerability.via)) continue;
  for (const via of vulnerability.via) {
    if (via && typeof via === 'object') {
      advisoryObjects.push({ packageName, ...via });
    }
  }
}

const severeAdvisories = advisoryObjects.filter(
  (item) => item.severity === 'high' || item.severity === 'critical'
);

const ALLOWED_BIGINT_BUFFER_GHSA = 'GHSA-3gc7-fjrx-p6mg';
const allowedUntil = process.env.ALLOW_BIGINT_BUFFER_UNTIL ?? '';
const today = new Date().toISOString().slice(0, 10);

function isAllowedBigintBuffer(item) {
  const haystack = `${item.packageName ?? ''} ${item.name ?? ''} ${item.title ?? ''} ${item.url ?? ''}`;
  return haystack.includes(ALLOWED_BIGINT_BUFFER_GHSA) ||
    (haystack.toLowerCase().includes('bigint-buffer') && haystack.toLowerCase().includes('buffer overflow'));
}

const disallowedAdvisories = severeAdvisories.filter((item) => !isAllowedBigintBuffer(item));
if (disallowedAdvisories.length > 0) {
  console.error('NPM_AUDIT_POLICY_FAIL unexpected high/critical advisories:');
  for (const item of disallowedAdvisories) {
    console.error(`- ${item.packageName}: ${item.severity}: ${item.title ?? item.url ?? 'unknown advisory'}`);
  }
  process.exit(1);
}

if (severeAdvisories.length === 0) {
  console.error('NPM_AUDIT_POLICY_FAIL high/critical vulnerability exists without a resolvable advisory object');
  for (const [packageName, value] of highOrCritical) {
    console.error(`- ${packageName}: ${value.severity}`);
  }
  process.exit(1);
}

if (!allowedUntil || !/^\d{4}-\d{2}-\d{2}$/.test(allowedUntil)) {
  console.error('NPM_AUDIT_POLICY_FAIL ALLOW_BIGINT_BUFFER_UNTIL is required for the known upstream exception');
  process.exit(1);
}
if (today > allowedUntil) {
  console.error(`NPM_AUDIT_POLICY_FAIL bigint-buffer exception expired on ${allowedUntil}`);
  process.exit(1);
}

// Ensure every high/critical entry can be traced through the vulnerability graph to
// at least one severe advisory, and every severe advisory is the explicitly allowed one.
function severeRoots(packageName, visiting = new Set()) {
  if (visiting.has(packageName)) return new Set();
  visiting.add(packageName);
  const value = vulnerabilities[packageName];
  const roots = new Set();
  if (!value || !Array.isArray(value.via)) return roots;
  for (const via of value.via) {
    if (typeof via === 'string') {
      for (const root of severeRoots(via, new Set(visiting))) roots.add(root);
    } else if (via && typeof via === 'object' && (via.severity === 'high' || via.severity === 'critical')) {
      roots.add(`${via.url ?? ''}|${via.title ?? ''}|${via.name ?? packageName}`);
    }
  }
  return roots;
}

for (const [packageName, value] of highOrCritical) {
  const roots = severeRoots(packageName);
  if (roots.size === 0) {
    console.error(`NPM_AUDIT_POLICY_FAIL ${packageName} (${value.severity}) has no traceable severe advisory root`);
    process.exit(1);
  }
  for (const root of roots) {
    if (!root.includes(ALLOWED_BIGINT_BUFFER_GHSA) && !root.toLowerCase().includes('bigint-buffer')) {
      console.error(`NPM_AUDIT_POLICY_FAIL ${packageName} traces to an unexpected severe advisory`);
      process.exit(1);
    }
  }
}

console.warn(
  `NPM_AUDIT_POLICY_EXCEPTION ${ALLOWED_BIGINT_BUFFER_GHSA} accepted through ${allowedUntil}; ` +
  'this is an explicit upstream-blocked availability-risk exception, not a clean audit.'
);
console.log(`NPM_AUDIT_POLICY_OK high/critical findings are limited to the documented bigint-buffer exception (${highOrCritical.length} affected package entries)`);
