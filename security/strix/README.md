# Strix Security Audit Runbook

This directory defines a controlled, repeatable Strix audit for `claude-project`.

## Automated PR security gate

Every pull request targeting `main` is scanned by `.github/workflows/strix-pr-security.yml`.

The gate follows the current Strix CI guidance:

- checks out full Git history so the PR base can be resolved safely;
- scans only the pull-request diff in `quick` mode;
- fails the PR when Strix returns validated findings (`exit 2`);
- fails closed when `strix_runs/*/run.json` is missing or its status is not `completed`;
- uploads `findings.sarif` to GitHub Code Scanning when that feature is available;
- always retains the Strix console log and `strix_runs/**` as workflow artifacts.

Required repository configuration:

- Repository secret: `STRIX_LLM_API_KEY` — provider API key used by the self-hosted Strix runner.
- Repository variable: `STRIX_LLM` — optional model id; defaults to `openai/gpt-5.4`.

Never commit API keys or other credentials.

## Current cycle

Cycle 1 is **source-only**. It must not actively test production or third-party infrastructure.

Rules of engagement:

- `ROE_SOURCE_ONLY.md`

Profiles:

- `instructions/01-baseline-source.md` — complete attack-surface and baseline review
- `instructions/02-authz-business.md` — auth, authorization, IDOR, payments and business logic
- `instructions/03-external-llm-infra.md` — SSRF, external integrations, LLM, secrets, Docker/Nginx/CI

## Manual GitHub Actions audit

The manual workflow `.github/workflows/strix-security-audit.yml` uses the same dedicated secret and optional repository variable:

- Repository secret: `STRIX_LLM_API_KEY` — required
- Repository variable: `STRIX_LLM` — optional; defaults to `openai/gpt-5.4`

The workflow validates `run.json.status == "completed"` before accepting a run and uploads SARIF when available.

## How Cycle 1 is run

Open GitHub Actions -> `Strix Security Audit - Source Only` -> `Run workflow`.

Start with these runs in order:

1. `repo` + `baseline` + `standard`
2. `solana-launcher` + `authz-business` + `standard`
3. `backend` + `authz-business` + `standard`
4. `admin-site` + `baseline` + `standard`
5. `memecoin-intelligence` + `external-llm-infra` + `standard`
6. `repo` + `external-llm-infra` + `standard`

Use a conservative per-run budget first. Increase it whenever the run stops early or cost approaches the configured cap closely enough that coverage may have been truncated.

## Exit-code handling

Strix headless exit codes:

- `0` — no validated vulnerabilities reported for what was analyzed
- `1` — execution error
- `2` — validated vulnerabilities found

The automatic PR workflow treats `2` as a failed security gate. The manual source audit retains evidence for review while independently validating each finding.

A zero exit code is not enough by itself: `run.json` must exist and report `status: "completed"`.

## Evidence handling

Every workflow run uploads:

- `strix-console.log`
- generated `strix_runs/**`

When SARIF is generated, the workflows also attempt to upload it to GitHub Code Scanning.

Do not accept a Strix result automatically. A final human/independent validation pass must classify each result as:

- `CONFIRMED`
- `NEEDS_PRODUCTION_VERIFICATION`
- `HARDENING`
- `FALSE_POSITIVE`

A confirmed issue requires a reachable source/sink path, concrete impact and safe reproduction evidence.

## Remediation workflow

For every confirmed finding:

1. reproduce the original PoC when feasible;
2. patch the root cause using the framework's built-in security controls;
3. add or update a regression test;
4. re-run the focused PoC or a diff-scoped Strix scan;
5. require a completed Strix run before classifying the finding as fixed.

For leaked credentials, code changes are not sufficient: rotate the credential and purge it from repository history where applicable.

## Planned later cycles

Cycle 2: targeted local dynamic reproduction of confirmed source findings.

Cycle 3: authenticated staging grey-box assessment using dedicated test accounts and test wallets.

Cycle 4: black-box staging assessment and infrastructure verification.

Cycle 5: remediation, regression tests and Strix re-test.

Production active testing is not part of Cycle 1.
