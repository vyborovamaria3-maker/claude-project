# Intelligence 2.2 — implementation status and acceptance gates

The data path is X PG / TG PG / Solana SQLite -> transactional source Outbox ->
bounded Intelligence ETL -> idempotent existing Inbox + Timeline / verified links ->
versioned features and API-backed AI -> alerts, research, and read-only API.

This is an additive DRAFT PR. Source collectors own originals; Intelligence owns
derived analytics only. No new microservice or duplicate Inbox is introduced.

## Migration 010 (after 001–006, 008 and 009)

| Component | Current status |
| --- | --- |
| Generated `available_at` on features, daily snapshots and alerts | SQL ready; built-in as-of API filters already guard write times |
| Score interpretation | SQL heuristic default; API explicitly labels scores non-probabilistic |
| Entity external mappings | Table only; no identity writer |
| Four-way coverage assessments | Table only; complete requires verified counts and evidence |
| Encrypted `event_text_snapshots` | Table only; no plaintext, no encryption producer or purge worker yet |
| Analytics lineage | Table only; not populated by all builders |
| Invalidation queue + log | Table and enqueue helper; X/TG link/revision events enqueue affected tokens; no general recomputation worker |
| Signal validation registry | Table and alert persistence gate; independent validation executor still required |
| AI cost ledger | Table plus successful typed AI-call accounting; invoice reconciliation missing |
| Gateway auth audit | Table only; cross-host gateway not deployed |

## Temporal and evidence contract

`occurred_at` is source occurrence; `observed_at` is collector observation;
`ingested_at` is Intelligence receipt; `analyzed_at` is AI completion;
`computed_at` is feature generation. `as_of` is a data cutoff; it is NOT
a signal availability timestamp. The DB generates `available_at` from the
stored computation/write timestamp and source cutoff to prevent backdating.

A corrected message or invalidated mint link requires a new derivative version,
not mutation of published history. A full lineage-driven recomputation worker
remains a follow-up. Unknown expected counts cannot be considered complete.

## Validation policy

A caller string `correlationValidation: "out_of_sample"` is not authoritative.
The persistence gate requires a matching registry record and completed backtest
with an identical dataset cutoff, >=20 labeled observations, a time-series
holdout/walk-forward/expanding method, publication before the alert, and a
non-expired deployment window. Simple `k_fold` research does not authorize
a validated trading alert. Registry row creation is NOT proof that a real
independent backtest has been executed: trusted validation-run production
and reproducibility-hash verification still need to be implemented.

Historical experiment correctness and current deployment applicability are
different statuses. Expiry suspends fresh alerts, not the historical backtest.

## Privacy and cost contract

Only external API providers are used; the new pipeline never starts local Qwen.
Message text presently comes from read-only X/TG adapters. The optional
encrypted table is NOT wired; text-retention, retraction, key management and
privacy review are preconditions to activation.

Successful typed AI responses record cost estimates by provider trace ID.
Failed paid requests, cross-worker reservations and billing reconciliation
remain separate work. Estimate != invoice.

## Do not declare production-ready until

- **P0**: Proven DB ownership/grants, backup restore to disposable PG and
  WAL-safe SQLite, consumer replay idempotency and live coverage auditing.
- **P0**: Verified identity-mapping and invalidation/recompute producers with
  edit/delete -> new snapshot integration tests.
- **P0**: Actual independent holdout/walk-forward runner that records
  reproducible dataset/code/model/seed hashes.
- **P0**: Key management, purge, permissions and privacy testing BEFORE
  enabling optional encrypted text storage.
- **P1**: Authenticated POTAPoff gateway and 401/403/200 + audit tests.
- **P1**: Cost reconciliation, shared budget enforcement across workers,
  monitored delays/coverage/invalidations, and repeatable restore drills.

CI tests use disposable Postgres fixtures and do not change real X/TG/Solana
databases, connect to live provider accounts or deploy public access.

## Code review update — October 23, 2026

Subsequent additive migrations 011, 012 and 013 extend the original governance
contract. All live activation remains explicit opt-in.

- `011_validation_preregistration.sql` adds an immutable policy with a
  database-owned registration timestamp. A holdout certificate must match its
  threshold, version, model/code revision and signal kind, and the policy must
  predate the evaluation period. Certificate generation crosschecks source
  features available at the signal time and explicit `token_outcomes` labels
  with source version/observation time.
- `012_ai_shared_budget.sql` adds per-provider UTC daily reservations for
  more than one worker. With `INTELLIGENCE_AI_SHARED_BUDGET_ENABLED=true`,
  requests reserve an allowance before calling the external API. The entire
  allowance remains charged if provider billing is unknown. This is an
  **estimated spend guard**, not proof that an API invoice is correct.
- `013_invalidation_retry_schedule.sql` adds `next_attempt_at`, fixing
  immediate reclaims that could exhaust all retries in one batch.
- The opt-in `invalidation:once` worker recomputes affected UTC days if they
  can be identified from source evidence. It keeps unknown/incomplete data
  unknown, rather than fabricating zeroes.
- The opt-in encrypted text import/read/purge implementation uses AES-256-GCM
  with authenticated event/revision binding. Source deletion tombstones
  cryptoshred existing ciphertext; new as-of token aggregates exclude deleted
  social messages. Real KMS, key rotation, legal retention policy and complete
  upstream deletion coverage must be verified before deployment.
- The `gateway:local` process enforces per-role Bearer authorization, logs
  allow/deny decisions before proxying, disallows HTTP redirects and bounds
  upstream response size while streaming. It binds loopback: there is no
  publicly accessible POTAPoff gateway or user-account identity integration.

### Still required before declaring production-ready

Independent human review of source schemas/grants, an isolated real-data
restore drill, representative source load/latency tests, verification that all
sources emit deletion and link retraction events, rate/cost invoice
reconciliation, expiry/rotation of AI keys and secrets, and a documented
POTAPoff host-to-host authentication and deployment plan. An automated CI
success is not proof that such operational checks have happened.
