# Strix Security Audit Runbook

This directory defines the controlled Strix audit program for `claude-project`.

## Current audit branch

`security/strix-audit-v1`

The branch was created from `main` commit `f3bc357eb71a054ed8da6052db47be39537672e1`.

## Files

- `ROE.md` — authorization, scope and prohibited actions.
- `TARGETS.md` — components and ordered passes.
- `AUTH_MATRIX.md` — expected actor/object authorization policy.
- `EXPECTED_CONTROLS.md` — security invariants Strix should attempt to disprove.
- `instructions/baseline.md` — high-confidence source baseline instructions.
- `.github/workflows/strix-source-audit.yml` — manual source-only runner.

## GitHub Actions prerequisites

Repository Actions secrets required by the manual workflow:

- `STRIX_LLM` — for example the provider/model configured for the audit.
- `LLM_API_KEY` — provider API key.
- `PERPLEXITY_API_KEY` — optional; only for Strix search capabilities.

Never commit these values to the repository.

## Strix version

The workflow installs Strix release `v1.4.1` from the official `usestrix/strix` repository and verifies that the checked-out release commit begins with `ac0014f` before installation.

## First run

Start with:

- component: `backend`
- scan mode: `standard`
- max budget: `10`

The first target is intentionally `solana-launcher/backend`, not the entire monorepo. The backend contains the highest-value auth/payment/session/database trust boundaries and gives a controlled baseline before widening scope.

## Interpretation

Strix headless behavior is treated as:

- exit `0`: scan completed with no confirmed vulnerability result;
- exit `1`: scan completed and reported vulnerability findings;
- other exit: execution/configuration failure.

The workflow captures the exit code, uploads evidence first, and only then enforces the result. Therefore vulnerability findings do not discard the report artifact.

## Evidence

Each run uploads:

- `strix_runs/**`
- `security/strix/runtime/strix-console.log`
- `security/strix/runtime/post-scan-git-state.txt`

Artifacts are retained for 30 days.

## Audit sequence

After the backend baseline is triaged:

1. backend standard baseline;
2. `solana-launcher` standard baseline;
3. `admin-site` standard baseline;
4. `memecoin-intelligence` standard baseline;
5. repository-level standard scan only after component runs are stable;
6. focused authentication pass;
7. focused authorization/IDOR pass;
8. injection + SSRF pass;
9. subscription/payment/business-logic + race/replay pass;
10. Telegram/X privacy and session pass;
11. AI/Qwen/prompt-injection pass;
12. dependency/supply-chain and infrastructure pass;
13. staging source+URL grey-box pass after a staging environment and test accounts exist;
14. staging black-box pass;
15. one-finding-at-a-time remediation and Strix retest.

## No automatic fixing

Audit workflows must not auto-merge or push fixes. A confirmed issue becomes a separate remediation change with:

1. isolated patch;
2. regression/security test;
3. existing test suite/build;
4. targeted Strix retest;
5. separate commit/PR.

## Production

Production targets are intentionally absent from the workflow. Adding production testing requires an explicit reviewed change to the ROE and workflow.