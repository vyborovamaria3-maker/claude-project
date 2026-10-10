# Intelligence platform implementation

This is an additive, single-database foundation. Existing collector accounts,
jobs, publication queues and the two-year archive are preserved. It is not a
claim that all production-scale analytics or external providers are configured.

## Data and provenance

Migrations 023 and 024 add the `ip_` namespace: entities, raw events, temporal
relations, mandatory durable relation sources, additional evidence, profiles,
taxonomy, tags, observations, behavior, transactions, identity links, clusters,
cluster membership and model-scoped embeddings. Scores are nullable.

Browser observations are saved atomically with operational tweets/profiles.
They are structured DOM observations, not original X API responses. Immutable
capture times distinguish repeated observations even if content is unchanged.
Raw events and evidence do not depend on the 90-day tweet/30-day job cleanup.
Normalization preserves unknown publication timestamps as null. A handle is an
observed identifier; a rename cannot be resolved reliably without a stable X ID.

Automatic relations currently include observed mentions and discussed hashtags.
Visible post references do not establish reply/quote/retweet semantics. Strings
resembling wallets never establish ownership. Rule tags indicate observed topics,
not a person's profession, fraud or bot status. Confidence is method-specific,
not a statistically calibrated probability. Weight counts distinct source posts,
not repeated metric captures.

## Run

From x-collector, after installing dependencies:

```powershell
npm run migrate
npm run build
node dist/scripts/intelligence-backfill.js
node dist/scripts/intelligence-worker.js --watch
node dist/scripts/intelligence-analytics.js
```

Configure this worker as a managed service alongside the collector for restart
recovery. It uses DATABASE_URL from x-collector/.env, not the website database.
Concurrent workers use row locks/SKIP LOCKED. Bad events have bounded attempts
and a generic error; inspect payload and explicitly reset attempts after repair.
Backfill replays existing tweet/profile observations in bounded batches, and
deduplicates captures. It does not yet import every legacy API archive format or
the retention-independent historical snapshots when operational observations
have already been removed.

Graph analytics operates on all observed account-to-account edges up to 100,000.
It refuses larger graphs rather than silently sampling them. Groups are connected
components, not confirmed real-world communities. Influence is relative PageRank
in this observed graph. Authority, trust and risk remain uncomputed. Cluster runs
retain earlier results; consumers must distinguish computation timestamps.

## API and interface

Settings → X Collector → "Открыть сущности, связи и историю", or `/intelligence`.

Read-only routes: `/api/entities`, `/api/entities/:id`, `/api/graph/nodes`,
`/api/graph/edges`, `/api/graph/relations`, `/api/graph/relations/:id/evidence`,
`/api/graph/analytics?entity=UUID`, `/api/tags`, `/api/clusters`,
`/api/search/similar?entity=UUID&model=MODEL`, `/api/wallet/:address?chain=CHAIN`.
List APIs bound limit to 200. Relations accept an `at` timestamp for history.
Responses never include account session/proxy credentials. Production uses the
existing authenticated subscription access gate; this is not tenant isolation or
an intelligence-specific administrator ACL.

Embeddings are stored by explicit model ID and checked for finite, non-zero
vectors. No embedding provider is configured automatically. Similarity is an
exact SQL cosine calculation, limited to 50,000 compatible vectors; above that
it refuses the scan until a vector index is provisioned. This is not a scalable
approximate-nearest-neighbor implementation.

Blockchain ingest is a transaction-scoped service for supplied Ethereum/Solana
observations. Amounts remain decimal strings/numeric. It creates wallet/token
entities and sourced transfers without claiming X ownership. It does not fetch
chain history, validate receipts with an RPC provider, handle reorgs, or expand
all transfers from multi-transfer transactions. Conflicting observations reject.
IdentityLink storage exists; identity inference/merge/review is not implemented.

## Remaining production work

1. Immutable original API/profile/list/action/transaction adapters and complete
   legacy/archive replay with persistent import checkpoints.
2. Stable external identity/aliases, human-reviewed identity resolution and
   provenance-backed ownership rules. Observed handles must not silently merge.
3. Evidence-aware relation lifecycle editing and manual/AI taxonomy assignment.
4. Verified chain adapters, transfer IDs/log indexes, confirmation/reorg handling.
5. Versioned embedding runs, provider/configuration, vector index and evaluations.
6. Incremental/partitioned graph algorithms, cluster run IDs/current versions,
   calibrated and validated trust/risk/authority methodologies.
7. Tenant/admin ACLs, audit logs, cursor pagination, retention/export policies,
   service supervision/metrics, queue failure controls and load/restore testing.
8. Rich graph navigation, inline evidence and wallet/transaction review, complete
   follower graphs and profile/archive inspection in the admin interface.

Do not call these unfinished components production-ready or fabricate analytics
values to populate the interface.
