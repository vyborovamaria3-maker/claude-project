# Blockchain collection and analytics: implementation status

## Source-of-truth decision

- `chain_seed_events` is the retained raw evidence layer for collector-observed transactions.
- `token_trades` remains the canonical input to the existing `lib/trade/chain/quality-v3.ts` FIFO/PnL pipeline until a separately reviewed migration proves parity.
- `chain_wallet_trades` is a derived, idempotent wallet-wide cache used for discovery, fast lookups, and reconciliation. It is not yet the source of truth for authoritative PnL.
- Reconciliation must compare signature, wallet/trader attribution, mint, direction, amount, slot, and decoder version. A mismatch is a quality issue, not a reason to silently overwrite `token_trades`.

## Decoder coverage is separate from pagination coverage

Current wallet cache decoding is **swap-only**. Token transfers are indexed as wallet-token discovery evidence, but transfer-in/out, mint, and burn are not yet fully represented as inventory movements. Therefore:
- `decoder_coverage='swap_only'` is the default;
- a finished API backfill does not imply complete inventory history;
- `history_status='complete'` is only allowed when pagination is complete, no gaps exist, and `decoder_coverage='full'`;
- the collector still passes `swap_only` for PnL and wallet-history completeness; inventory evidence is recorded separately and does not promote `decoder_coverage` to `full`;
- PnL remains non-authoritative unless the caller supplies full decoder coverage, unknown-operation ratio <= 5%, stable/finalized evidence, complete inventory provenance, complete ordering, and verified reconciliation of canonical `token_trades` against leg-level raw evidence.

The 5% unknown-operation threshold is a hard gate, not a confidence adjustment. Unknown ratios must be calculated from a defined denominator of relevant wallet/token operations; they must not be guessed. Until that denominator is measured, the gate must fail closed.

## Evidence and finality

Every cached trade stores `raw_event_signature` and `raw_event_slot`. The event signature must equal the trade signature. The cache currently records `reorg_status='pending_confirmation'`; no finalized/reorg watcher has been implemented yet, so cached rows are not eligible for authoritative PnL.

## Coverage and cost accounting

- `chain_history_coverage` records the observed slot range, event count, decoder coverage, and reason for incomplete coverage. `coverage_percent` and `expected_count` remain NULL unless there is an independently measured denominator.
- `chain_budget_ledger` records observed HTTP request attempts as `cost_kind='http'`. Helius credits and Alchemy CU must be recorded separately only when provider-specific cost data is available; the system must not infer credit/CU costs from HTTP count.
- Alchemy `getTransactionsForAddress` is the primary historical provider for the local seed collector. The collector uses its opaque `paginationToken`, requests finalized full transactions, rotates configured Alchemy keys on retryable failures, and never silently falls back to Helius.
- Alchemy response metadata records successful pages, empty final page, and actual HTTP attempts including retries. HTTP attempts and CU are separate ledger entries; the CU estimate is 100 per `getTransactionsForAddress` request per Alchemy's published endpoint documentation.
- `chain_wallet_pagination_state` keeps pagination metadata separate from logical backfill/forward cursors.

## Discovery, clusters, and scoring

Token mints seen in a wallet's swap legs or token transfers are written to `chain_wallet_token_touched` and may be queued with low priority. This is discovery evidence, not proof of a trade or ownership identity.

`chain_wallet_cluster_candidates` is candidate-only. Shared funding or co-activity must never automatically merge wallet identities.

`chain_wallet_smart_money_metrics` stores versioned component metrics and confidence bounds. No production smart-money score is considered implemented until its model and calibration are versioned and tested.

## Deterministic data confidence

The wallet cache exposes a deterministic confidence function:
`history_complete × decoder_coverage × (1 - unknown_operations_ratio) × cost_basis_complete × ordering_complete × reorg_stable`.
Any missing required signal contributes zero. This score is a quality indicator, not a substitute for the hard AUTHORITATIVE gate.

## API savings baseline

Baseline: every wallet discovery triggers a full history fetch.
Cache scenario: a complete, fresh wallet history should trigger zero new HTTP requests; a stale or partial history should be refreshed/resumed.
Measure `rpc_requests_per_wallet_discovery`, `cache_hit_ratio`, and `cost_per_wallet_lifetime` from `chain_budget_ledger`. Do not publish a savings percentage before collecting comparable measurements.

## SQLite migration evaluation thresholds

Evaluate PostgreSQL migration when any of the following is sustained:
- `trade.db` exceeds 5 GiB;
- SQLite WAL exceeds 1 GiB;
- COMMIT exceeds 100 ms for a 10,000-row batch;
- SQLITE_BUSY / database-locked errors occur more than once per hour.

These are evaluation triggers, not automatic guarantees that PostgreSQL will solve the observed bottleneck.

## Provider contract

- Primary provider: Alchemy Solana RPC `getTransactionsForAddress`, with `transactionDetails: full`, `encoding: jsonParsed`, `commitment: finalized`, and `paginationToken` pagination (up to 100 full transactions per page).
- Cursor values are versioned as `alchemy:v1:<paginationToken>`. Provider changes invalidate old provider-specific cursors and completeness flags while retaining raw events.
- Raw normalized events retain slot, timestamp, transaction error, fee, token-balance deltas, instruction program IDs, and parsed SPL transfer/mint/burn instruction evidence where supplied by the RPC response.
- The swap decoder remains conservative and marked `swap_only`; balance deltas or a recognized DEX program alone do not establish complete inventory provenance. Authoritative PnL remains blocked until decoder coverage, source reconciliation, ordering, and finality are independently proven.
- Missing Alchemy configuration fails closed. Helius is not a runtime fallback for the seed collector.

## Offline trade reconciliation and inventory evidence

- `blockchain-inventory-decoder.cjs` extracts parsed SPL transfer/mint/burn instruction evidence into `chain_inventory_movements`. It deliberately leaves unresolved ownership unresolved and does not create BUY/SELL trades.
- `blockchain-trade-reconciliation.cjs` compares normalized trade signatures against observed raw transaction evidence and reports missing signatures, failed/unknown execution metadata, slot/owner/direction mismatches, and events with mint deltas but no normalized trade. A clean result is diagnostic only; it does not establish history completeness.
- Run the read-only audit from `solana-launcher` after a local collection has been performed: `node scripts/blockchain-trade-reconcile.cjs <mint> [max-trades=100000]`. It opens `data/trade.db` in read-only mode, makes no API calls, and always marks the report `diagnostic_only`.
- The inventory decoder and reconciliation tests use local fixtures only. They do not call Alchemy or start collection.

## Status at this revision

Implemented schema/code scaffolding:
- wallet discovery and swap-leg cache;
- decoder coverage gate for wallet history;
- history coverage and HTTP-attempt ledger tables;
- evidence signature/slot fields;
- pagination state;
- reorg/finality fields, defaulting to pending;
- token discovery from wallet transfers;
- deterministic data confidence and PnL quality gate helpers;
- cluster-candidate and versioned score-component tables.

Still not implemented or not independently verified:
- complete inventory ledger reconstruction from transfer/mint/burn movements, including token-account closure, ownership changes, airdrops, account creation/deletion, and all Token-2022 extensions;
- finalized/reorg monitoring;
- complete wiring of provider-specific credit/CU cost data;
- authoritative population of unknown-operation ratios;
- end-to-end reconciliation of `chain_wallet_trades` with `token_trades`;
- live API tests and local pilot DB verification.

Until these gaps close, the cache is swap-only and the wallet history/PnL must remain non-authoritative.

## Targeted signature evidence CLI

`scripts/blockchain-signature-events.cjs` reads existing `token_trades` signatures for one mint. It never starts address history collection, updates trades, or marks coverage complete. Missing evidence is selected deterministically, at most 100 signatures per invocation (default 10). Failed transactions are retained as evidence; null, mismatched, malformed or oversized responses are not stored. Re-running skips stored signatures for that mint. Provider retries may mean multiple HTTP requests per signature.

Run from `solana-launcher`:

```text
node scripts/blockchain-signature-events.cjs --db <trade.db> --prepare --backup <new-backup.db>
node scripts/blockchain-signature-events.cjs --db <trade.db> --mint <mint> --limit 10
```

Preparation uses SQLite online backup (including committed WAL), verifies the backup with quick_check, then transactionally adds nullable slot/quote/fee columns and the compatible chain_seed_events table/index. It refuses existing backup paths. Keep the verified backup if migration fails; no invented values are backfilled. Preparation has no network path. Default planning opens the DB read-only and does not load provider credentials. Do not restore by copying over a running SQLite database; stop writers and preserve its WAL before rollback.

Only an explicit `--execute` on the planning command performs finalized `getTransaction` requests through the existing Alchemy provider. Configure credentials through existing Alchemy environment variables or local dotenv files. Each saved payload is normalized by the existing normalizer and gzip-compressed. Events are written under kind=token/address=mint; no inventory projections are created. Partial failures return nonzero and preserve already saved evidence for resumption. The default plan does not prove that selected rows are valid swaps. Use `blockchain-trade-reconcile.cjs` afterwards from the folder whose data/trade.db was prepared. A targeted signature audit cannot discover transactions absent from token_trades or establish complete history.
