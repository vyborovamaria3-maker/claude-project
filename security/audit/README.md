# Security audit runbook

This directory contains the reproducible security-audit workflow for this repository.
All active testing is restricted to systems owned by the project or explicitly authorized for testing.

Latest full repository source audit: [`../FULL_REPO_SECURITY_AUDIT_2026-09-06.md`](../FULL_REPO_SECURITY_AUDIT_2026-09-06.md).

## Local source gate — no GitHub Actions required

Run from the repository root:

```bash
npm run security:audit:local
```

This command runs:

1. `security/audit/secret-scan.py --mode current` against tracked source;
2. `security/audit/full-repo-regression.py` for high-risk cross-project security invariants.

It is intentionally dependency-light so it can run on a workstation/VPS even while GitHub-hosted runners are unavailable. A passing local source gate does **not** replace dependency audits, application tests or live DAST.

For deeper local/VPS AI-assisted source testing, use the separately documented Strix runner:

```bash
npm run security:strix:deep
```

Treat a Strix run as evidence only if its `run.json` reports a completed run. Budget-stopped/incomplete scans are not clean results.

## Repository-wide secret scanning

`.github/workflows/secret-scan.yml` is intentionally separate from the heavier project-specific security workflow. When GitHub Actions runners are available, it runs on every PR/push to `main` and scans:

- current tracked files;
- newly introduced PR lines;
- reachable Git history.

Secret values are never intentionally printed by the scanner. Historical hits still require provider-side credential rotation; removing a value from the current tree is not sufficient closure.

## Profiles

- `production`: conservative. Web-vuln-scanner runs passive checks only; ghostmap uses same-host scope, low concurrency and delay. XHunter is disabled.
- `staging`: active DAST. Web-vuln-scanner runs bounded active probes; ghostmap runs XSS/SQLi probes; XHunter can be run against a curated URL list. Time-based SQLi remains opt-in.

Never enable WAF bypass, OAST, time-based SQLi, clusterbomb, or high concurrency against production by default.

## Required runtime variables

```bash
export AUDIT_AUTHORIZED=yes
export AUDIT_TARGET=https://staging.example.com
export AUDIT_PROFILE=staging
```

Optional authenticated scan material must be provided at runtime and must never be committed:

```bash
export AUDIT_COOKIE='session=...'
export AUDIT_HEADER='Authorization: Bearer ...'
```

Run:

```bash
bash security/audit/run-dast.sh
```

Reports are written to `security/audit/reports/` by default. That directory should remain untracked when it contains session-specific evidence.

## Scanner installation

### Web-vuln-scanner / webscan

Pinned upstream project: `feadal/Web-vuln-scanner`.

```bash
git clone https://github.com/feadal/Web-vuln-scanner.git
cd Web-vuln-scanner
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

The runbook uses request/page budgets and a delay. In production it invokes `--passive-only`.

### ghostmap

Pinned upstream project: `joemunene-by/ghostmap`.

```bash
git clone https://github.com/joemunene-by/ghostmap.git
cd ghostmap
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

ghostmap is used as a second XSS/SQLi implementation for cross-validation. A scanner finding remains `NEEDS_VERIFICATION` until reproduced.

### XHunter

Pinned upstream project: `gilsgil/xhunter`.

```bash
go install github.com/gilsgil/xhunter@latest
```

XSS mode requires ChromeDriver. XHunter SQLi detection is time-based, so this project disables it in the production profile and requires `AUDIT_ENABLE_TIME_SQLI=yes` on staging/lab.

### ticwebtools

Pinned upstream project: `ticarpi/ticwebtools`.

`JSattack.js` and `libChex.js` are manual browser-assessment helpers. Host them only in an isolated testing environment. Never publish JSattack output: it can contain JavaScript-accessible cookies, storage, DOM data, variables, functions and other session material.

## Finding states

Every result is triaged as one of:

- `NEW`
- `NEEDS_VERIFICATION`
- `CONFIRMED`
- `FALSE_POSITIVE`
- `FIXED`
- `RETEST_FAILED`
- `CLOSED`

Automated reports are evidence candidates, not proof by themselves.

## Manual coverage after DAST

Automated scanners do not replace the following checks:

1. Telegram identity and replay resistance.
2. BOLA/IDOR across user A, user B, admin and anonymous roles.
3. Payment replay, failed-chain transaction handling and concurrent confirmation.
4. Webhook authentication and replay/idempotency.
5. File upload and object ownership where applicable.
6. Business-logic state transitions and race conditions.
7. SSRF sinks with controlled callback infrastructure on staging only.
8. CSRF for cookie-authenticated state-changing endpoints.
9. CORS and security headers at the actual public ingress.
10. Rate limiting at application and reverse-proxy layers.

## Completion criteria

The **source pass** is complete when confirmed source/configuration findings are remediated and documented.

Operational closure additionally requires:

- security CI or equivalent local test suites actually execute and pass;
- no P0/P1 finding remains open except a documented time-bounded/upstream-blocked exception;
- dependency audits have no unresolved high/critical issue without an explicit exception;
- every historical real secret has been provider-side rotated/revoked;
- production and authenticated staging DAST have been executed against authorized reachable URLs;
- confirmed DAST findings have regression tests where practical;
- a final retest marks fixed findings `CLOSED`.
