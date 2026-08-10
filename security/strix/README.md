# Strix Security Audit Runbook

This directory defines a controlled, repeatable Strix audit for `claude-project`.

## Current cycle

Cycle 1 is **source-only**. It must not actively test production or third-party infrastructure.

Rules of engagement:

- `ROE_SOURCE_ONLY.md`

Profiles:

- `instructions/01-baseline-source.md` — complete attack-surface and baseline review
- `instructions/02-authz-business.md` — auth, authorization, IDOR, payments and business logic
- `instructions/03-external-llm-infra.md` — SSRF, external integrations, LLM, secrets, Docker/Nginx/CI

## GitHub Actions prerequisites

The manual workflow uses a dedicated secret and optional repository variable:

- Repository secret: `STRIX_LLM_API_KEY` — required
- Repository variable: `STRIX_LLM` — optional; defaults to `openai/gpt-5.4`

Never commit the API key.

## How Cycle 1 is run

Open GitHub Actions -> `Strix Security Audit - Source Only` -> `Run workflow`.

Start with these runs in order:

1. `repo` + `baseline` + `standard`
2. `solana-launcher` + `authz-business` + `standard`
3. `backend` + `authz-business` + `standard`
4. `admin-site` + `baseline` + `standard`
5. `memecoin-intelligence` + `external-llm-infra` + `standard`
6. `repo` + `external-llm-infra` + `standard`

Use a conservative per-run budget first. Increase only if a run terminates cleanly and evidence quality justifies it.

## Exit-code handling

Strix headless exit codes:

- `0` — no vulnerabilities found
- `1` — execution error
- `2` — vulnerabilities found

The manual audit workflow treats exit `2` as a completed security assessment so artifacts are retained. Exit `1` remains a workflow failure.

## Evidence handling

Every workflow run uploads:

- `strix-console.log`
- generated `strix_runs/**`

Do not accept a Strix result automatically. A final human/independent validation pass must classify each result as:

- `CONFIRMED`
- `NEEDS_PRODUCTION_VERIFICATION`
- `HARDENING`
- `FALSE_POSITIVE`

A confirmed issue requires a reachable source/sink path, concrete impact and safe reproduction evidence.

## Planned later cycles

Cycle 2: targeted local dynamic reproduction of confirmed source findings.

Cycle 3: authenticated staging grey-box assessment using dedicated test accounts and test wallets.

Cycle 4: black-box staging assessment and infrastructure verification.

Cycle 5: remediation, regression tests and Strix re-test.

Production active testing is not part of Cycle 1.
