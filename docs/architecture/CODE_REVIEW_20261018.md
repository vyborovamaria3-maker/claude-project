# Code review — X/TG/Blockchain → Intelligence, 18 October 2026

## Scope and evidence

Reviewed source-side PRs #121 (TG), #122 (X), #123 (Blockchain);
Intelligence delivery and outbox PR #124, and security primitives from #112.
This audit examined real source file diffs and CI failures and added new
regression tests. It does **not** claim the entire 18-stage AI platform,
existing trade logic, or live user-data pipelines have been fully audited.

All PRs remain Draft; no user production PostgreSQL/SQLite databases,
credentials, browser or MTProto sessions were accessed. All collector flags
remain disabled by default. X Collector remains laptop-local.

## Confirmed defects fixed

| Severity | Location | Failure mode | Remedy |
| --- | --- | --- | --- |
| High | TG #121 | `tg:peer:message:deleted:v1` was constant: after restoring/deleting the same message again, second deletion was deduplicated away | DB deletion uses `clock_timestamp()`, exact UTC microsecond deletion revision is hashed into the event key; unit + PG integration regression |
| Medium | X #122 | 15-digit lower bound on tweet ID dropped older positive numeric tweet IDs | Accept stable positive numeric ID 1..25 digits; forbid `0` and handles; tests |
| High | Blockchain #123 | Wallet ID validation could be weaker than decoded Solana 32-byte key contract | Require decoded address length exactly 32 bytes; test malformed length |
| High | Outbox #124 | ACK/NACK verified only worker owner, not a particular claim; reused worker ID could acknowledge a newer lease with stale event state | ACK/NACK now require matching exact `lease_until` and owner; SQLite/PG reclaim tests |
| High | Outbox #124 | PG maps `Date` through `String(date)`, dropping milliseconds. This broke the new exact lease fence even on valid claims | Preserve `Date.toISOString()` precision; real PG tests exposed and verified the fix |
| High | Intelligence #124 | Envelope checked timeline event key but not whether timeline source evidence/entity IDs/clocks matched registry evidence | Verify same source ID/kind, parser/provenance, observed/occurred clocks, and complete entity references before opening destination; forged-source tests |
| Medium | Intelligence #124 | Original synthetic integration reused one PG schema for source and destination, hiding mistakes in cross-DB isolation | Added independent X PG schema + TG PG schema + destination PG schema test (plus existing actual SQLite source test) |
| Medium | Shared utils #112/#124 | Arbitrary structured log fields could overwrite the logger's timestamp, level, subsystem, message | Reserved log fields are assigned last; added spoofing regression |

## Verification performed

- PR #121: TG Collector checks and security suite (new deletion test), GitHub CI.
- PR #122: X Collector quality, monitoring, pinned XActions and hygiene suite.
- PR #123: blockchain regression, predeploy and frontend/security suites.
- PR #112: shared-utils regression test and hygiene suite.
- PR #124: temporary PostgreSQL and real SQLite claims/ACK/NACK, cross-DB
  destination tests, provenance mismatch regression, local CLI safety, and
  Intelligence foundation suite.

**Verify latest commit statuses individually** before merge: PR #124's
additional revisions re-trigger CI, so older green results are insufficient
proof of its new head. No local user environment smoke test was performed.

## Release blockers — do not merge blindly / do not activate live

1. PR ancestry is split. #110–120 → #124 are stacked on older main; #121,
   #122, #123 and #125 branch from a newer main. Reconcile file trees and
   migration ledgers before merging, rebasing or cherry-picking. No force-push.
2. Need backup AND restore test of the real source PG schemas and WAL-safe
   SQLite `trade.db`; only then apply reviewed additive migrations X 050,
   TG 015 and Intelligence destination 001–003.
3. Explicit local activation sequence: install target, check consumer status,
   confirm producer schemas, run an isolated small ETL batch, then turn on
   producer opt-ins. Never run mass historical replay automatically.
4. One batch currently claims a fixed lease (120 seconds) with NO renewal.
   A very slow batch may expire and redeliver, correctly fenced, but replay
   may increase load. Local supervision, lease renewal, shutdown/drain,
   worker health, throughput/backpressure and DLQ operations remain to build.
5. X records without stable numeric author ID are intentionally skipped by
   the new producer, not linked from mutable handles; source-side historical
   backfill and coverage counters still needed.
6. Telegram peers lacking stable numeric `peer_id` fail closed when producer
   enabled; must resolve through actual Telegram metadata before backfill.
7. Blockchain wallet raw events are NOT trades. No authoritative PnL may be
   published without decoder, history and cost basis completeness.
8. No complete verified mint resolver, trained local AI model/embedding
   pipeline, actual feature producer, strict prediction calibration or
   source-based walk-forward backtest yet. Don't claim AI deployment.
9. Event identity collision guard currently compares schema/evidence source;
   for mutable complete payload materialization, add a content fingerprint or
   revision contract (and migrations) to detect same-key changed entity sets.
10. API v1 admin authorization/UI, live recovery drills, retention, schema
    drift on both engines and rate/cost budgets need separate checks.

## Recommended Codex next action

Use `docs/architecture/CODEX_FINAL_INTEGRATION_PLAN_20261018.md`.
Start by fetching latest main and PR #110–125 refs; verify **latest**
workflow statuses; inspect migrations and conflicts. Complete the source
DB backup/restore and ephemerally test combined PR file trees, then ship a
bounded laptop-local supervised ETL worker with graceful stop, renewed leases,
backpressure, and event counts. Only afterwards perform tiny real-data smoke
tests with explicit operator approval. Keep `main` and live sessions untouched
until the rollout gates are independently satisfied.
