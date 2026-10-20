# Listed PR integration review — 2026-10-20

Scope: #126, #127, #133–#150. User explicitly authorized merges and the normal automatic production deployment. Main remains unchanged until the combined candidate passes latest-head CI. #133 is the final integration carrier; stacked PRs are merged into their bases and independent PRs retargeted into that carrier to avoid publishing intermediate product states.

## Confirmed integration issues fixed

- #138/#145 resolver conflict: retain the strict parsed SPL Mint reader, version-scoped/retryable candidate updates, source locking, peer/edit revision provenance and outbox opt-ins, together with soft-deleted occurrence filtering, ticker retraction and history corrections. The occurrence helper now includes peer_id/edited_at and confirmed-current filtering. Disposable-PG fixture is updated to represent a confirmed candidate, and an executable offline query contract checks the retained provenance.
- #126/current collector: retain RAW-only automatic collection. Decode saved Pump fixtures offline and exercise the explicit wallet-cache path, but assert zero automatic token_trades writes and all RAW revisions retained. Do not silently reenable a deprecated projection to make an old test pass.
- #126 transfer graph: require strictly ordered checked-transfer edges; a reversed routed chain must be rejected.
- #142 Windows tests: explicitly close SQLite readers (transaction context alone does not close a connection), and resolve Bash executable to avoid accidentally selecting the broken WSL shim.
- Conflict resolution preserves both sets of blockchain regressions and workflow path watches, and both sets of progress notes.

## Validation and limits

X typecheck and full local 382 tests passed. TG strict typecheck and local tests passed (database integration runs in disposable CI PostgreSQL). Sentiment local 64 tests pass with one PostgreSQL skip. Pump retained fixtures decode 5 BUY/5 SELL offline and the conservative rejection/RAW-only persistence regression passes. Full combined CI, including disposable PostgreSQL, synthetic backup/restore, product builds and security checks, remains required before the main merge.

Only isolated checkouts and temporary/synthetic test databases are used locally. Existing public retained transaction fixtures are offline inputs, not authenticated proof of provider origin or finalized trades/PnL. No manual production DB connection, migration, model download, paid RPC or credential extraction. Deployment is the repository's existing authorized release workflow, with its SSH pin and readiness gates retained.
