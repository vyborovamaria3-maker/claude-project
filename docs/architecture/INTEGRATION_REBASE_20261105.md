# PR #212 integration on current main — 2026-11-05

## Snapshot and method

- Repository: `vyborovamaria3-maker/claude-project`
- Current base at branch creation: `d7fc77235fa3134e764349c77010fad336b73c5b`
- Source integration PR head inspected: `2661bd77484f03f8efba21588b30eaa68fea53e4`
- Common ancestor of that PR and current main: `f4dc5ef3aad400f64fc300f30542085e10aae4c1`
- Main advanced by 64 commits after the common ancestor; PR #212 contained 272 commits and was 64 commits behind current main.
- The PR diff against the common ancestor contained 110 paths: 27 additions, 82 modifications and 1 deletion.

This branch is a fresh integration snapshot based on current main. It carries the PR #212 file changes onto the current main tree; it does not merge the old PR branch ancestry or rewrite main.

## Conflict reconciliation

Four paths were changed independently on both sides:

1. `admin-site/app/main_admin.py`: preserved the newer main FOMO evaluation and author-outcomes routers, while adding the PR's Admin PostgreSQL preflight imports and checks.
2. `solana-launcher/Dockerfile.frontend.prod`: retained Node 22 from current main and included the PR's runtime checks for `better-sqlite3` and Playwright metadata.
3. `solana-launcher/package.json`: preserved the newer main FOMO scripts and analysis tests; added the Compose safety test, safe default `compose:down`, explicit opt-in volume-removal command, and Node >=22 engine declaration.
4. `docs/CODEX_PROGRESS.md`: retained the newer main version rather than replacing it with an older progress snapshot from the integration branch.

The PR's deletion of `x-collector/lib/intelligence/cross-chain-correlator.ts` is retained together with its updated tests and Solana-only chain contract.

## Validation status

The source PR head had 27 successful workflow runs, 1 skipped conditional workflow, and no failed runs in the retrieved PR-triggered run set. Those checks apply to the old PR head, not this new integration commit.

Fresh CI must run on this branch. No local test runner was available through the GitHub connector, so no new local test result is claimed.

## Explicitly unresolved operator gates

- Main branch protection / required checks: the connected GitHub integration cannot read the branch-protection endpoint (403, resource not accessible). Repository issue #170 explicitly requires an administrator to verify and configure this. No branch protection or ruleset was changed.
- Physical production database inventory and real restore rehearsal: not performed; issue #172 remains an operator gate.
- Live X, Telegram and Solana verification: not performed; issue #175 remains NOT RUN pending explicit account/source/RPC approval.
- Real production role cutover, live migration, credential rotation, off-host encryption and deployment were not performed.

## Safety

No production database, external account, live collector, Solana RPC, secret, or production server was accessed or modified. No Docker volume or production data was deleted. The default Compose shutdown command no longer requests volume deletion; volume removal remains an explicit separate command.
