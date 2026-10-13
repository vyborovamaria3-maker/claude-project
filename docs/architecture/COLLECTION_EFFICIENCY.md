# Collection checkpoints and throughput

Automated list collection uses PostgreSQL `xc_list_checkpoints` (migration 039). A full 100-result page continues with `max_id`; after the available chain completes, the newest saved ID becomes the next cycle's `since_id`. The watermark never advances on a failed page or non-advancing cursor. Initial list backfill and historical author/topic windows use priority 1; first pages and incremental list updates use priority 2. Existing native-list requests are adopted without interpreting their repost IDs as search pagination checkpoints.

Automatic collection permits account fallback explicitly through `account_fallback`. Manual account selection stays strict. Only collector accounts are eligible. Waiting for a quota/lease defers the task without consuming an attempt; the wait follows the earliest eligible account availability. HTTP/session failures still obey bounded retries and quarantine.

Saved batches survive interruption. Collection deadlines throw instead of returning a misleading successful partial result. Membership discovery requires an observed scroll end without a loading indicator. X search completeness is never guaranteed.

Run `node --import tsx scripts/collect-lists.ts` and `node scripts/history-collector.cjs` alongside the worker. Both coordinators use singleton PostgreSQL advisory locks. Run `node scripts/collection-status.cjs` for list counts, checkpoints, history periods and quota usage. Resume a failed page with `--resume-list LIST_ID`; resume failed history windows with `--resume-history RUN_ID`; re-read list members with `--refresh-members RUN_ID`. The settings panel also offers a list retry button for partial collection.

Validation: 190 unit/SQL/browser tests passed; targeted checkpoint and account fallback cases passed. Real PostgreSQL runtime integration passed, including a five-connection scheduler cycle. The additional monitoring integration was skipped locally without TEST_DATABASE_URL. Typecheck/build/lint passed (two existing lint warnings). Live list-feed and search probes failed to load X results, so increased live throughput and complete collection are not claimed.
