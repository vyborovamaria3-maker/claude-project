# ARCH-01 — X/TG/Blockchain → Intelligence data contracts

Verified against repository main at \`8dc7c2943ef08978f55009b15c86cd451517b654\` on 2026-10-20. This is an **inventory**, not a claim of live deployment or full historical coverage. Preserve independent collection databases and laptop-local X/TG/Blockchain workers.

## Ownership and boundaries

| Domain | Owner / storage | Canonical source records | Integration state |
| --- | --- | --- | --- |
| X | \`x-collector\` / independent PostgreSQL; authoritative migration manifest \`lib/trade/migrations.ts\` | tweets, authors, metric observations, \`tweet_token_links\`, \`outbox_events\` (migration 050) | Opt-in \`X_INTELLIGENCE_OUTBOX_ENABLED=true\`; default-off |
| TG | \`tg-collector\` / independent PostgreSQL; native numbered SQL ledger | \`tg_messages\`, \`tg_sources\`, \`tg_message_links\`, \`tg_tokens\`, \`tg_token_candidates\`, \`outbox_events\` (migration 015) | Opt-in \`TG_INTELLIGENCE_OUTBOX_ENABLED=true\`; default-off |
| Blockchain | \`solana-launcher/data/trade.db\` / SQLite with WAL-aware backup | \`chain_seed_events\` raw evidence, \`token_trades\` legacy authoritative analytics input, derived wallet caches, SQLite \`outbox_events\` | Opt-in \`BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=true\`; default-off |
| Cross-source Intelligence (Node) | \`intelligence/src\` and \`intelligence/migrations/001–003\` / **separate** PostgreSQL | \`intelligence_inbox\`, \`entity_registry\`, \`entity_evidence\`, \`timeline_events\`, \`timeline_event_entities\`, \`feature_versions\`, \`chain_token_features\` | Bounded CLI \`intelligence/scripts/run.mjs\`; \`INTELLIGENCE_ETL_ENABLED=true\` needed for \`--once\`; **no supervised continuous worker verified** |
| POTAPoff Python Intelligence | **Also located under \`intelligence/\`**: \`cli.py\`, \`bootstrap.py\`, \`storage/\`, \`scoring/\`, \`worker/\` | Separate \`intelligence_documents\` and \`intelligence_jobs\` PostgreSQL schema, or dedicated SQLite backend | Different Python runtime with GitHub/web/RSS/YouTube providers; **not** the Node outbox ETL |
| POTAPoff backend/UI | \`solana-launcher\`: Next.js + separate Python backend and Alembic migrations | UI/API and existing trade evidence | X/TG/Blockchain Settings are separate controls, not a verified unified Token Intelligence API |
| Memecoin Intelligence | \`memecoin-intelligence\` / independent PostgreSQL + Redis | Own feature/graph and optional AI research | Not automatically part of Node Intelligence destination |
| Admin | \`admin-site\` / own SQLite operational state | \`admin_audit\`, \`revoked_admin_sessions\`, \`feature_flags\`, \`alerts\` | Admin/control domain; not a canonical token DB |
| Subscription / MiniApp / MCP | \`solana-subscription-service\`, \`telegram-miniapp\`, \`mcp-servers\` | Separate product state; MCP can read local trade DB | Keep out of token-evidence bus unless a specific use case is justified |

**Do not count these as one interchangeable PostgreSQL or one shared authentication domain.** No physical database/schema migration is authorized by this inventory.

## Identity (existing \`packages/contracts/src/canonical-ids.ts\`)

| Kind | Canonical format | Validation / caveat |
| --- | --- | --- |
| Solana token | \`solana:<full-base58-mint>\` | Address must decode to exactly 32 bytes; syntactic validity does **not** prove it is a token mint |
| Solana wallet | \`solana:<full-base58-address>\` | Same address format; must not confuse a token account with a verified owner |
| EVM token/wallet | \`ethereum/base/arbitrum:0x<40-hex-lowercase>\` | Explicit chain, lower-case normalized |
| X author | \`x:<stable-numeric-author-id>\` | Never a mutable \`@handle\` |
| X source | \`x:account:<stable-numeric-id>\` | Account identity, not author promotion/ownership evidence |
| TG source | \`tg:source:<stable-numeric-peer-id>\` | Never \`tg_sources.id\` local surrogate or mutable username |
| Evidence | \`x:tweet:<tweet_id>\`; \`tg:message:<peer_id>:<message_id>\`; \`chain:tx:<chain>:<signature-or-hash>\` | Provenance refers to source observation; identity and event revision are distinct |

**Adapter discrepancy:** Telegram \`tg_tokens.chain_id\` / candidates may use \`solana-mainnet\`, while shared \`Chain\` uses \`solana\`. A versioned adapter must explicitly map *verified* mainnet Solana records to the canonical chain. Reject unsupported networks and ambiguous IDs. Preserve native source strings for audit.

## The confirmed missing link

The existing **source** outbox emitters do not yet produce verified canonical \`token\` refs:

| Source emitter | What is actually emitted in the base event | Why it is not a token link |
| --- | --- | --- |
| \`x-collector/src/collector/persistence/intelligence-outbox.ts\` | \`author\` ref; \`tweet_observed\`, \`tweet_published\` timeline | Search-query mint and author handle cannot prove a tweet mentions that mint |
| \`tg-collector/src/persistence/outbox.ts\` | \`source\` ref; message revisions and separate soft-deletes | Text/ticker/candidate is not an on-chain-verified mint |
| \`solana-launcher/scripts/blockchain-intelligence-outbox.cjs\` | \`wallet\` ref; raw wallet observation | Raw transfer/provider response is not a verified swap, token mint or PnL |

The destination has a \`queryTokenTimeline(...)\` function, but it filters \`timeline_event_entities.kind='token'\`. Therefore **three successful source deliveries do not alone produce a populated token timeline**. Do not invent token refs from context or promote an arbitrary Solana public key.

Proposed next contract, after evidence review: a separate, *revisioned and retractable* **token-link observation** attached to the exact X/TG/chain evidence ID, with source parsing version, resolution status, validation method, observation time, canonical token ID only for verified links, and explicit retraction on edited/deleted evidence. Add a new event kind and additive migrations; do not retroactively mutate historical outbox event keys.

## Event/delivery invariants already implemented

1. Persist native source row and outbox revision event in **the same source DB transaction**.
2. Claim with lease, commit the claim, then write destination transaction.
3. Destination \`intelligence_inbox\`, registry/evidence and optional timeline commit before source ACK.
4. Duplicate \`(source_system,event_kind,event_key)\` is idempotent; expiry/failed ACK may legitimately cause **at-least-once** replay. No exactly-once cross-database transaction.
5. \`occurredAt\` and \`observedAt\` are distinct; as-of timeline queries require both cutoffs.
6. Writer emits sanitized provenance, not X cookies, TG session, proxy credentials, raw secret URLs, or unreviewed message bodies.
7. Rollout flags remain OFF until backups, verified migrations, a functioning target, and isolated failure/restart tests.

**Known residual:** collision detection compares event identity/schema/evidence source, but a duplicate key with a changed complete entity set/payload is not yet fully fingerprinted. Treat this as a blocker for mutable materialized links; see \`KNOWN_GAPS.md\`.

## Independent migration contracts

- X: the **explicitly ordered** \`x-collector/lib/trade/migrations.ts\` manifest, including repeated historical numeric prefixes and \`050_intelligence_source_outbox.sql\`; never sort just by prefix or rewrite applied files.
- TG: its own native SQL/checksum runner; \`015_intelligence_outbox.sql\` is followed by later independent migrations through \`022_external_discovery.sql\`.
- Blockchain: existing WAL-aware SQLite \`trade.db\`; source outbox table is additive in the opted-in local startup path.
- Node Intelligence: isolated destination PostgreSQL migration order \`001_entity_registry.sql\`, \`002_timeline.sql\`, \`003_feature_store.sql\`.
- Python Intelligence: **separate** storage schema in \`intelligence/storage/postgres_schema.sql\`; not a replacement for Node migrations.

## Verification and rollout gates

- Existing tests: \`intelligence/tests/cross-db-delivery.test.mjs\`, \`isolated-source-delivery.test.mjs\`, \`delivery.test.mjs\`, \`timeline-postgres.test.mjs\`; standalone adapters have PG/SQLite tests.
- ARCH-03 adds \`cross-source-token-timeline.test.mjs\`: three physically separate source stores (X/TG isolated PG schemas + SQLite) → destination PG, synthetic **preverified** token refs, as-of boundaries and replay idempotency. **It proves destination handling only; source token resolvers do not yet exist.**
- CI: \`.github/workflows/intelligence-foundation.yml\` uses disposable PostgreSQL 16 and Node 22 and sets \`INTELLIGENCE_TEST_DB_URL\`.
- No live credentials, no user database migrations, no X/TG login, no Solana RPC or external publication should be required by ARCH-01/03.
- Manual production activation only after backed-up/restore-tested native databases, applied migrations, runbook and explicit operator gate.

See \`docs/architecture/CODEX_FINAL_INTEGRATION_PLAN_20261018.md\` for earlier integration caveats and \`docs/architecture/KNOWN_GAPS.md\` for current release blockers.
