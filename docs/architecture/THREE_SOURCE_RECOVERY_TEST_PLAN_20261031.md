# Three-source delivery and recovery test plan — 2026-10-31

Status: disposable integration-test evidence only. This is not a live-source
certification, deployment runbook, backup/restore rehearsal or approval to
enable any collector.

Related acceptance: [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173)
and [#174](https://github.com/vyborovamaria3-maker/claude-project/issues/174).
The cross-source delivery implementation is in Node Intelligence; the source
collectors and blockchain SQLite store remain separate owners.

## Test topology

```text
X source fixture (isolated PostgreSQL schema) -----+
                                                    |
TG source fixture (isolated PostgreSQL schema) ----+--> Intelligence destination
                                                    |    (isolated PostgreSQL schema)
Blockchain source fixture (in-memory SQLite) ------+
```

The automated integration test is
`intelligence/tests/verified-three-source-outbox-postgres.test.mjs`.
It creates three random PostgreSQL schemas for X, TG and the destination, and
uses a separate in-memory SQLite database for Blockchain. It applies only the
destination migrations 001, 002, 004 and 005 to its disposable destination
schema. It drops its random schemas and closes the SQLite database in
`finally`.

The test uses synthetic, preverified source evidence. It does not call X,
Telegram MTProto, Alchemy, Helius or Solana RPC and does not read a production
collector database. Source-specific producer tests are separate and are listed
below.

## Automated recovery assertions

The current integration test covers:

1. Source primary write and Outbox insert are atomic: a source rollback leaves
   neither a primary observation nor an orphaned Outbox row.
2. X and TG preserve distinct native evidence IDs while asserting the same
   canonical `solana:<mint>`; Blockchain emits a separate wallet/signature raw
   revision.
3. A different mint query returns no X/TG/chain attribution. Historical
   `occurredBefore` and `knownAt` cutoffs do not backdate late ingestion.
4. A forced destination COMMIT failure rolls back the destination and does not
   ACK the source event. The event is then eligible for a bounded retry.
5. A real PostgreSQL source lease is expired. Its old fencing token cannot ACK;
   a subsequent worker can reclaim the event.
6. A TG edit tombstone removes TG's active assertion but preserves X and
   Blockchain evidence. A later X edit removes only X. A TG deletion tombstone
   removes TG without erasing the independent chain observation.
7. A later unsupported Blockchain raw revision supersedes a previously
   supported parsed-swap attribution. It does not claim that the transaction
   never happened; it only removes the old mint attribution from the current
   evidence projection.
8. After destination COMMIT but simulated source ACK loss, all three sources
   replay. The destination records duplicates rather than duplicate evidence
   or resurrected links.
9. A permanent failure reaches the configured retry threshold, enters the
   PostgreSQL dead-letter state, clears the lease and is excluded from normal
   claims.

Related tests provide additional coverage for lease renewal, failed renewal,
retry scheduling, source identity collision and event payload validation:
`intelligence/tests/delivery.test.mjs`,
`intelligence/tests/isolated-source-delivery.test.mjs`,
`intelligence/tests/postgres.test.mjs`,
`packages/event-outbox/tests/outbox.test.mjs` and
`packages/event-outbox/tests/postgres-live.test.mjs`.

## Reproduce locally — disposable database only

Requirements: Node.js 22+, npm, and a disposable PostgreSQL 16 database whose
test role can create and drop schemas. Never point
`INTELLIGENCE_TEST_DB_URL` at a production, shared user, X, TG or Intelligence
database. The test creates random schemas and drops them; it does not attempt
to discover whether an arbitrary DSN is production.

Install and check the local packages in the order used by CI:

```sh
npm install --prefix packages/contracts --ignore-scripts --no-package-lock --no-audit
npm --prefix packages/contracts run check
npm install --prefix packages/event-outbox --no-package-lock --no-audit
npm --prefix packages/event-outbox run check
npm install --prefix packages/ai-gateway --no-package-lock --no-audit
npm --prefix packages/ai-gateway run check
npm install --prefix intelligence --no-package-lock --no-audit
```

Set only the disposable test database URL, then run:

```sh
INTELLIGENCE_TEST_DB_URL=postgresql://test:testpass@127.0.0.1:5432/intelligence_test npm --prefix intelligence run check
```

PowerShell equivalent:

```powershell
$env:INTELLIGENCE_TEST_DB_URL = 'postgresql://test:testpass@127.0.0.1:5432/intelligence_test'
npm --prefix intelligence run check
Remove-Item Env:INTELLIGENCE_TEST_DB_URL
```

The repository workflow
`.github/workflows/intelligence-foundation.yml` provisions PostgreSQL 16
as a disposable service, sets `INTELLIGENCE_TEST_DB_URL`, and runs
`npm --prefix intelligence run check`. The test is skipped when that variable
is absent; a green run must therefore be checked for the explicit integration
test's execution, not inferred from a generic package pass.

## Source producer tests — local fixtures only

These checks validate source-side builders/transaction behavior independently
of the destination integration test. They do not use live accounts or RPC.

```sh
cd x-collector
npm ci
node --import tsx --test tests/verified-token-links.test.ts

cd ../tg-collector
npm ci
node --import tsx --test tests/verified-token-link.test.ts

cd ../solana-launcher
node scripts/blockchain-token-swap-outbox-test.cjs
```

- X uses PGlite and tests the default-off gates, explicit proof contract,
  same-transaction insert/rollback, deduplication and edit invalidation.
- TG tests the default-off gates, stable numeric peer IDs, literal mint
  boundary, private-text exclusion and the verified producer contract.
- Blockchain uses in-memory SQLite and the actual collector persistence path
  to test raw revisions, atomic rollback, replay and unsupported superseding
  revisions.

## What remains NOT RUN / not accepted by these tests

- Real X account reads and the real Alchemy-backed X mint verification flow.
- Real Telegram MTProto login, authorized channel ingestion and actual edit/
  delete events.
- Live Blockchain RPC acquisition, provider provenance, finality/reorg checks
  and independently operated witness services.
- Full production source coverage, sustained throughput and process restart on
  a real workstation/server.
- Production DB inventory, physical backup verification, isolated restore,
  measured RPO/RTO, and operator-approved migration/rollback.
- A named production owner, start/stop/recovery procedure, external alert sink,
  retained alert history and DLQ operator/requeue procedure.

Issue #173 therefore remains open for authorized live source/proof validation
and independent provenance. Issue #174 remains open for operational ownership,
backup-first rollout, external alerting and a rehearsed supervisor restart,
lease, DLQ and restore procedure. PR #206's read-only metrics/JSON alerts do not
provision an external alert sink or process manager.

No environment opt-ins are enabled by this plan. Do not set source flags, start
the supervisor against production DSNs, apply migrations to source databases,
or deploy based on these test results.
