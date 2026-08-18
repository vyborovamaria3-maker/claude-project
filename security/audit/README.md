# Security audit runbook

This directory contains the reproducible security-audit workflow for this repository.
All active testing is restricted to systems owned by the project or explicitly authorized for testing.

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

The audit is complete only when:

- security CI passes on the audit PR;
- no P0/P1 finding remains open;
- dependency audits have no unresolved high/critical issue without an explicit exception;
- secret-history scan passes or every hit has been rotated and documented;
- production and authenticated staging DAST have been executed against reachable URLs;
- confirmed DAST findings have regression tests where practical;
- a final retest marks fixed findings `CLOSED`.
