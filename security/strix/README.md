# Strix Security Audit Runbook

This project runs Strix locally or on a VPS. GitHub Actions is not required for Strix security scanning.

## What the local runner does

`scripts/strix-scan.sh` provides a repeatable source-only security scan with the existing rules and profiles in this directory.

The runner:

- validates Git, Node.js, Docker, Strix and `LLM_API_KEY` before spending tokens;
- scans the exact committed `HEAD`, not uncommitted working-tree changes;
- creates a full isolated temporary clone before scanning because local Strix code targets are mounted writable;
- keeps git metadata inside that clone so `--scope diff` works without touching the real checkout;
- combines `ROE_SOURCE_ONLY.md` with the selected project-specific profile;
- always passes `--max-budget`;
- captures the Strix console output and generated evidence locally;
- requires `run.json.status == "completed"` before a run can be accepted;
- warns when reported LLM cost is close to the configured cap;
- exits `2` when Strix reports validated vulnerabilities;
- stores local evidence under `security/strix/reports/`, which is ignored by git.

The isolated clone is deleted after each scan. Reports are retained in the real project checkout.

## Prerequisites

The machine running the scan needs:

1. Git
2. Node.js
3. Docker with a running daemon
4. Strix CLI
5. an LLM provider API key

Check Strix:

```bash
strix --version
```

If it is not installed:

```bash
curl -sSL https://strix.ai/install | bash
```

Do not commit provider API keys.

## Local configuration

Copy the template:

```bash
cp security/strix/.env.example security/strix/.env
```

Then edit `security/strix/.env`:

```dotenv
STRIX_LLM=openai/gpt-5.4
LLM_API_KEY=your-provider-key
STRIX_COMPONENT=repo
STRIX_PROFILE=baseline
STRIX_SCAN_MODE=standard
STRIX_MAX_BUDGET=10
STRIX_SCOPE_MODE=full
STRIX_DIFF_BASE=main
```

`security/strix/.env` is covered by the repository `.gitignore`.

You can also export the variables in the shell instead of using the file.

## npm commands

Default standard scan:

```bash
npm run security:strix
```

Quick scan:

```bash
npm run security:strix:quick
```

Standard scan:

```bash
npm run security:strix:standard
```

Deep scan:

```bash
npm run security:strix:deep
```

Fast diff scan against `main`:

```bash
npm run security:strix:diff
```

The npm commands use the root repository configuration and can be overridden with explicit runner flags.

## Components and profiles

Components:

- `repo` — entire repository
- `solana-launcher` — `solana-launcher/`
- `backend` — `solana-launcher/backend/`
- `admin-site` — `admin-site/`
- `memecoin-intelligence` — `memecoin-intelligence/`

Profiles:

- `baseline` — complete source attack-surface review
- `authz-business` — auth, authorization, IDOR, payments and business logic
- `external-llm-infra` — SSRF, external integrations, LLM, secrets, Docker and infrastructure

Examples:

```bash
bash scripts/strix-scan.sh \
  --component backend \
  --profile authz-business \
  --mode standard \
  --budget 10
```

```bash
bash scripts/strix-scan.sh \
  --component repo \
  --profile external-llm-infra \
  --mode quick \
  --scope diff \
  --diff-base main \
  --budget 10
```

## Recommended source-audit cycle

Run these in order after committing the code you want to audit:

1. `repo` + `baseline` + `standard`
2. `solana-launcher` + `authz-business` + `standard`
3. `backend` + `authz-business` + `standard`
4. `admin-site` + `baseline` + `standard`
5. `memecoin-intelligence` + `external-llm-infra` + `standard`
6. `repo` + `external-llm-infra` + `standard`

Increase the budget if a scan stops early or coverage in the generated report is incomplete.

## Exit handling

The local wrapper preserves Strix's useful headless contract:

- `0` — completed and no validated vulnerabilities were reported for what was analyzed
- `1` — configuration/execution/incomplete-run failure
- `2` — completed and validated vulnerabilities were reported

A Strix exit code of `0` by itself is not considered sufficient. The wrapper additionally requires a generated `run.json` with `status: "completed"`.

## Reports

Each run gets its own ignored directory:

```text
security/strix/reports/
  20260906T180000Z-repo-baseline-standard-abc123def456/
    local-run.txt
    strix-console.log
    penetration_test_report.md
    run.json
    findings.sarif
    vulnerabilities.json
    vulnerabilities.csv
    vulnerabilities/
```

`local-run.txt` records the commit, branch, profile, component, model, scope, budget and original Strix exit code. It never records `LLM_API_KEY`.

Reports may contain sensitive URLs, payloads or application context, so the directory is intentionally not committed.

## VPS / cron

A VPS does not need GitHub Actions. Clone the repository normally, create `security/strix/.env`, ensure Docker is running, and execute the npm command.

Example nightly cron entry at 03:15:

```cron
15 3 * * * cd /srv/claude-project && git fetch origin main && git checkout main && git reset --hard origin/main && /usr/bin/npm run security:strix:standard >> /var/log/claude-strix.log 2>&1
```

Use an absolute `npm` path from `command -v npm` on that server. Keep the repository and the Strix env file readable only by the service account.

If you do not want the VPS to change its checkout automatically, remove the `git reset --hard origin/main` part and deploy/update the repository separately.

## Rules of engagement

The current cycle remains **source-only**. It must not actively test production or unrelated third-party infrastructure.

Rules:

- `ROE_SOURCE_ONLY.md`

Profiles:

- `instructions/01-baseline-source.md`
- `instructions/02-authz-business.md`
- `instructions/03-external-llm-infra.md`

## Finding validation and remediation

Do not accept a Strix result automatically. Classify each result as one of:

- `CONFIRMED`
- `NEEDS_PRODUCTION_VERIFICATION`
- `HARDENING`
- `FALSE_POSITIVE`

For every confirmed finding:

1. reproduce the original PoC when feasible;
2. patch the root cause using framework/platform security controls;
3. add or update a regression test;
4. re-run the focused scan or `npm run security:strix:diff`;
5. require another completed Strix run before marking the finding fixed.

For leaked credentials, source changes alone are not sufficient: rotate the credential and purge it from repository history where applicable.

## Later cycles

Cycle 2: targeted local dynamic reproduction of confirmed source findings.

Cycle 3: authenticated staging grey-box assessment using dedicated test accounts and test wallets.

Cycle 4: black-box staging assessment and infrastructure verification.

Cycle 5: remediation, regression tests and Strix re-test.

Production active testing is not part of Cycle 1.
