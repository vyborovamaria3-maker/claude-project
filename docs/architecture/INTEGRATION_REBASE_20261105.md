# PR #215 integration on current main — 2026-11-05

## Snapshot and method

- Repository: `vyborovamaria3-maker/claude-project`
- Current base at branch creation: `d7fc77235fa3134e764349c77010fad336b73c5b`
- Source integration PR #212 HEAD inspected: `2661bd77484f03f8efba21588b30eaa68fea53e4`
- Common ancestor of the source PR and current main: `f4dc5ef3aad400f64fc300f30542085e10aae4c1`
- Main advanced by 64 commits after the common ancestor; the old PR #212 branch had diverged and was 64 commits behind current main.
- The source PR diff against the common ancestor contained 110 paths: 27 additions, 82 modifications and 1 deletion.
- PR #215 now contains the reconciled integration plus two new outbox-health files and documentation updates. It remains OPEN / DRAFT and is not merged.

This is a fresh integration snapshot based on current main. It carries the selected PR #212 working-tree changes onto the current main tree; it does not merge the old PR branch ancestry or rewrite main.

## Conflict reconciliation

Four paths were changed independently on both sides:

1. `admin-site/app/main_admin.py`: preserved the newer main FOMO evaluation and author-outcomes routers, while adding the PR's Admin PostgreSQL preflight imports and checks.
2. `solana-launcher/Dockerfile.frontend.prod`: retained Node 22 from current main and included the PR's runtime checks for `better-sqlite3` and Playwright metadata.
3. `solana-launcher/package.json`: preserved the newer main FOMO scripts and analysis tests; added the Compose safety test, safe default `compose:down`, explicit opt-in volume-removal command, and Node >=22 engine declaration.
4. `docs/CODEX_PROGRESS.md`: retained the newer main version rather than replacing it with an older progress snapshot from the integration branch.

The PR's deletion of `x-collector/lib/intelligence/cross-chain-correlator.ts` is retained together with its updated tests and Solana-only chain contract.

## Additional supervisor health work

PR #215 adds `intelligence/scripts/outbox-health.mjs`, tests and a PostgreSQL source-connection guard. Status/backfill PostgreSQL pools start with `default_transaction_read_only=on` and a reader application name; SQLite status/backfill connections use `readonly: true`. This session mode is not a security boundary: the underlying source login must still be a dedicated least-privilege reader. Read-only source outbox snapshots report:

- pending, ready, leased, retry-delayed and dead-letter counts;
- retry event count, retry attempt total and maximum attempts;
- oldest pending event timestamp and age;
- last successful source progress timestamp and age.

The foreground supervisor emits a health JSON record at startup/first batch and then every 30 seconds per source. Local warning records are emitted for any dead-letter item, oldest pending age of at least 15 minutes, or at least five retrying events. These records go to stdout only; there is no Prometheus exporter, Alertmanager, external notification sink or durable alert history.

## Validation status

The source PR #212 head previously had 27 successful workflow runs, 1 skipped conditional workflow and no failed runs in the retrieved PR-triggered set. Those checks apply to the old PR head, not to PR #215.

At PR #215 head `b8c8b31342cf58350ec3cbbc04924a3f44fb5fa8`, before the current documentation update, GitHub reported 48 check runs: 1 success, 1 in progress, 45 queued, 1 skipped and 0 failures. CI was not complete. This documentation commit changes the head; refresh all checks on the new exact SHA before claiming CI completion.

## Explicitly unresolved operator gates

- Main branch protection / required checks: the connected GitHub integration cannot read the branch-protection endpoint (403, resource not accessible). The last successful 2026-11-03 read reported `protected:false`; current state must be confirmed by a repository administrator under issue #170. No branch protection or ruleset was changed.
- Physical production database inventory and real restore rehearsal: not performed; issue #172 remains an operator gate.
- Live X, Telegram and Solana verification: not performed; issue #175 remains NOT RUN pending explicit account/source/RPC approval.
- Real production role cutover, live migration, credential rotation, off-host encryption and deployment were not performed.
- The central recovery bundle does not cover every independent stateful store (X/TG/Node Intelligence PostgreSQL, Memecoin, SolSub, MiniApp, Redis and RabbitMQ still need their own verified backup/restore owners).

## Safety

No production database, external account, live collector, Solana RPC, secret, or production server was accessed or modified. No Docker volume or production data was deleted. The default Compose shutdown command no longer requests volume deletion; volume removal remains a separate explicit command.
