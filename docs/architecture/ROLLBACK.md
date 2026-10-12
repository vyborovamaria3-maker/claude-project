# Rollback

1. Stop producers/scheduler and let workers drain. For Docker, stop worker/scheduler/dashboard services without deleting volumes.
2. Restore the original user-supplied source ZIP or prior image, run npm ci and build if using local compiled execution.
3. Keep the same PostgreSQL database and MASTER_KEY. This slice adds no schema changes and does not delete application data.
4. Restart the prior processes. Expired claimed tasks are reclaimed by the existing queue; inspect DLQ instead of bulk changing status.
5. The old code still has the documented ownership/transaction defects, so prefer reverting individual incompatible changes after diagnosis.

Do not use docker compose down -v for rollback. Do not run old and new workers with the same fixed identity concurrently. New worker IDs always include instance UUIDs.
