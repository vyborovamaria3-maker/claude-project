# ADR-0001 — Independent stores, scoped runtime ownership and verified evidence

- **Date:** 2026-10-24
- **Status:** Proposed; not a deployment authorization.
- **Owner / reviewers:** repository maintainer, source collector maintainers and Intelligence maintainer (assignment pending).
- **Related issues:** [#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172), [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173), [#174](https://github.com/vyborovamaria3-maker/claude-project/issues/174)

## Context

X and TG maintain independent PostgreSQL state, blockchain evidence is also held in local SQLite, Node cross-source Intelligence uses a distinct PostgreSQL destination, while Python Intelligence is a separate NLP/document runtime with its own store. Telegram native `solana-mainnet` mint identity is not automatically the same field as shared `solana:<verified mint>`. The transactional outbox is an at-least-once building block, not a cross-database atomic transaction or an always-on queue deployment.

## Proposed decision

1. Preserve source-native primary keys and stores. Use explicit versioned adapters at the source/destination boundary; no broad consolidation by a documentation PR.
2. Only **verified and provenance-backed mint observations** join independent X/TG/chain evidence. A ticker or username is never sufficient. Revisions and retractions must invalidate only the affected source claim.
3. Source-record + outbox emission is atomic in the **source DB**; destination commit precedes source ACK. Retries and duplicate deliveries are safe/idempotent, identity collisions fail closed.
4. Preserve both `occurredAt` and `observedAt` to avoid future information leaking into historical views.
5. Name Node Intelligence **cross-source ETL/timeline** and Python Intelligence **document/provider NLP** separately in deployment inventory; maintain separate auth and storage privileges.
6. Enable live source adapters only after backup/restore, isolated replay/retraction tests, supervised consumer and per-provider authorization are verified.

## Consequences and alternatives

- **Pros:** defensible provenance, cross-source correction, limited blast radius, lower risk of accidental source DB migration.
- **Trade-offs:** delivery latency, duplicate handling, explicit resolver lifecycle, multiple physical stores and additional monitoring.
- **Rejected pending evidence:** treating all local stores as one DB, exactly-once cross-DB transport, promoting all Solana-shaped addresses/tickers to verified mints, assuming a CI-green fixture equals live proof.

## Acceptance for promotion to Accepted

Review linked issues, current PR #165 implementation and schema contracts; demonstrate isolated replay/retraction failure tests and document source migration/rollback. Record named maintainer approval and acceptance date.
