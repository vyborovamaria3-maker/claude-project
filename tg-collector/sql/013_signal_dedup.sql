-- Keep null-source, minute-bucket signals idempotent across refresh runs.
CREATE UNIQUE INDEX IF NOT EXISTS tg_signals_aggregate_minute_unique_idx
  ON tg_signals(signal_type,chain_id,mint,model_version,(date_trunc('minute',detected_at AT TIME ZONE 'UTC')))
  WHERE source_id IS NULL AND message_id IS NULL;
