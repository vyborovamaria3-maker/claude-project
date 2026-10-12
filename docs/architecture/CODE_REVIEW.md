# Review of final integration

Review was a separate self-review of diff, callers, lock order, failure semantics and built artifacts; no independent human review is claimed.

Fixed P1 findings: expired owner renewal/acknowledgement; same-name stale attempts; alternative search bypassing account ownership; nested transaction/FK visibility; early task acknowledgement; heartbeat-driven revocation; inferred bans on rate limiting; stale account status writes. Result transaction locks task then account, matching renewal order. Counter/heartbeat writes drain before stopped status. Renewals do not overlap and are awaited before releasing account.

Fixed P2 findings: unused fake router/non-atomic account scaffold; unredacted core logger; ignored Retry-After; successful scheduler tick after caught ML error; duplicate local Dashboard worker autostarts; build missing src/CJS/browser; conflicting Docker autostart; Linux-only test launcher. HTTP 401 quarantine was verified after a browser failure test exposed incomplete message classification.

Regression review: original collection algorithms, list/top/history routing, result fields, auth/origin checks, queue schema, AI normalizer and launcher public entrypoints retained. New source search only handles latest non-history/non-list tasks. Automatic idempotency hashing preserves the former shallow key ordering; nested objects are now canonicalized.

Dashboard mutations now fail closed without configured credentials even on loopback; unauthenticated local reads remain compatible. The launcher integration already invokes requireProdAuth and same-origin checks; its process storage remains local.

Remaining P2: four moderate transitive Solana SDK advisories; fully durable launcher control; real quota/global breaker design; long archive retention/load tests. Epoch leases require synchronized clocks. SQL transaction commits can still be uncertain on connection loss; existing AmbiguousCommitError avoids blind retries. Crash-created raw files may require retention cleanup. The SQL queue guard is enforced through the supported producer APIs, not arbitrary direct INSERTs.

Follow-up: corrected account errors being treated as permanent task failures and standalone HTTP 401/403 classification. Added SQL-backed two-account recovery regression for both statuses.
