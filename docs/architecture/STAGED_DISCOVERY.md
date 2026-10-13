# Collection order and small VPS profile

Migration 040 adds an opt-in PostgreSQL plan. Enable it with:

```
node scripts/setup-discovery.cjs RUN_ID LIST_ID_1 LIST_ID_2 LIST_ID_3
```

Use an existing two-year history run containing the three lists. The current history coordinator and list coordinator must both run. Apply migrations and rebuild first.

Stage 1 reads membership, traverses the lists' available search pages and collects the requested date range for every discovered author. Missing authors, paused runs, failed membership, partial list checkpoints and incomplete author windows block stage 2. Already queued historical topic tasks also wait at execution time; deferral does not consume retry attempts.

Stage 2 continuously searches seven editable topic groups in `xc_discovery_sources`: Solana memecoins, launches, memes/humor, politics, news, crypto events and viral culture. Broad queries use engagement thresholds to reduce noise; they deliberately exclude some low-engagement posts. This is search coverage, not all of X and not evidence of correlation or causation. No local model or GPU is required. Existing analytics can consume the collected records; this change does not calculate new price correlations.

Each source pages backward with `max_id` and advances its incremental `since_id` watermark only after a complete available page chain. Search failures preserve the cursor and mark the source partial. Retry one with `node scripts/collection-status.cjs --resume-topic NAME`. Only one topic task is queued at a time; normal list/history tasks retain higher priority. Failures do not silently skip to an apparently complete stage.

The enabled plan defaults to one leased collector account globally. A transactional advisory lock serializes account selection across workers and the membership coordinator, preventing overlapping collector account leases. This cap does not include unrelated publishers, interactive login browsers or other applications. VPS memory consumption still needs measurement; it is not a guarantee that 2 GB will suffice. Use `PG_POOL_MAX=3`, run only the necessary coordinators, cap PostgreSQL memory and add swap on the 2 GB VPS.

Status: `node scripts/collection-status.cjs` includes the plan message, topic progress and existing list/archive coverage. PostgreSQL remains authoritative across process restarts.
