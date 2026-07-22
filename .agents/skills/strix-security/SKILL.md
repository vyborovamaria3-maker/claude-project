---
name: strix-security
description: Application-security audit workflow for finding, confirming, fixing, and reporting vulnerabilities. Use when Codex needs to scan a codebase, reduce false positives, produce safe local PoCs, propose patches, add tests, or integrate security checks into CI/CD for authorized projects.
---

# Strix Security

## Goal

Find real vulnerabilities, confirm them with evidence, and provide fixes that fit the codebase.

## Workflow

1. Inventory application boundaries: entrypoints, routes, auth, data stores, external APIs, secrets, package manifests, CI, and deployment files.
2. Run low-noise checks first: dependency audits, secret scans, unsafe API searches, auth/authorization review, input validation review, SSRF/path traversal/XSS/injection patterns, webhook signature checks, and config exposure checks.
3. For each candidate issue, build a minimal local PoC or test that demonstrates the vulnerable behavior without harming real systems.
4. Patch confirmed issues using existing project patterns.
5. Add or update tests that fail before the fix and pass after it when feasible.
6. Recommend CI/CD integration using tools already present before adding new scanners.

## Reporting

For each finding, include severity, affected files, impact, reproduction, fix, verification, and remaining risk.

Separate confirmed vulnerabilities from hardening recommendations, false positives, and disproven hypotheses.

## Boundaries

Stay within authorized code and environments. Do not perform destructive exploitation, credential theft, stealth, persistence, or testing against third-party assets without explicit authorization.
