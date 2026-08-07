# Database integration contract

The database is PostgreSQL-first and avoids ORM-specific metadata. To merge it into another project later:

1. Apply `db/migrations/001_init.sql`.
2. Apply `db/migrations/002_partitions.sql`.
3. Apply `db/migrations/003_performance.sql`.
4. Point `DATABASE_URL` to the target database.
5. Keep table names, or expose compatibility views if the target project uses different names.
6. Replace repository implementations only when the target project already owns equivalent tables.

Canonical identities:

- token: `(chain, mint_address)`
- X account: normalized lowercase `handle`, with optional `x_user_id`
- X post: `(id, created_at)` because `x_posts` is time-partitioned
- token mention: `(token_id, post_id, post_created_at, match_type)`
- extracted features: `(post_id, post_created_at)`

Large-data choices:

- monthly range partitions for `x_posts` and `token_snapshots`;
- BRIN indexes for append-heavy time-series scans;
- GIN indexes for contracts, links, mentions, hashtags, tickers and words;
- fingerprint index for exact normalized-copy detection;
- chunked `unnest` upserts for portable batch ingestion;
- JSONB for provider-specific payloads and evolving metrics;
- normalized edge/cluster tables for graph-engine export;
- additive migrations, so the schema can be embedded without adopting this repository's build system.

The `embedding real[]` column is intentionally portable. It can later be migrated to pgvector after the target database has the extension installed.

## Optional Telegram AI schema

Apply `db/migrations/004_telegram_qwen_ai.sql` only when the destination project needs Telegram analysis. It adds its own `telegram_*` namespace of tables and does not change X/token tables. The application uses composite `(id, sent_at)` references so partitioned Telegram messages remain portable in PostgreSQL 16.
