import type Database from "better-sqlite3";

export function ensureFomoSnapshotSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fomo_snapshot_capture_runs (
      run_id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running','captured','duplicate','failed')),
      x_status TEXT NOT NULL DEFAULT 'unknown' CHECK(x_status IN ('unknown','available','unavailable')),
      tg_status TEXT NOT NULL DEFAULT 'unknown' CHECK(tg_status IN ('unknown','available','unavailable')),
      failure_code TEXT,
      snapshot_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fomo_capture_runs_recent
      ON fomo_snapshot_capture_runs(requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fomo_capture_runs_mint_recent
      ON fomo_snapshot_capture_runs(mint, requested_at DESC);

    CREATE TABLE IF NOT EXISTS fomo_score_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      canonical_token_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      signal_at INTEGER NOT NULL,
      max_input_observed_at INTEGER NOT NULL,
      bucket_start_at INTEGER NOT NULL,
      score_version TEXT NOT NULL,
      fomo_pressure REAL NOT NULL CHECK(fomo_pressure BETWEEN 0 AND 100),
      fomo_quality REAL NOT NULL CHECK(fomo_quality BETWEEN 0 AND 100),
      quality_coverage REAL NOT NULL CHECK(quality_coverage BETWEEN 0 AND 1),
      x_coverage TEXT NOT NULL CHECK(x_coverage IN ('complete','partial','unknown')),
      tg_coverage TEXT NOT NULL CHECK(tg_coverage IN ('complete','partial','unknown')),
      source_coverage_known_at INTEGER NOT NULL,
      x_observed_at INTEGER NOT NULL,
      tg_observed_at INTEGER NOT NULL,
      x_sample_count INTEGER NOT NULL CHECK(x_sample_count >= 0),
      x_matched_count INTEGER NOT NULL CHECK(x_matched_count >= 0),
      x_truncated INTEGER NOT NULL CHECK(x_truncated IN (0,1)),
      x_cached INTEGER NOT NULL CHECK(x_cached IN (0,1)),
      tg_sample_count INTEGER NOT NULL CHECK(tg_sample_count >= 0),
      tg_matched_count INTEGER NOT NULL CHECK(tg_matched_count >= 0),
      tg_truncated INTEGER NOT NULL CHECK(tg_truncated IN (0,1)),
      capture_config_json TEXT NOT NULL CHECK(json_valid(capture_config_json)),
      source_meta_json TEXT NOT NULL CHECK(json_valid(source_meta_json)),
      x_input_sha256 TEXT NOT NULL CHECK(length(x_input_sha256)=64 AND x_input_sha256 NOT GLOB '*[^0-9a-f]*'),
      tg_input_sha256 TEXT NOT NULL CHECK(length(tg_input_sha256)=64 AND tg_input_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
      snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
      created_at INTEGER NOT NULL,
      UNIQUE(canonical_token_id, score_version, bucket_start_at),
      CHECK(max_input_observed_at <= signal_at),
      CHECK(source_coverage_known_at <= signal_at),
      CHECK(x_observed_at <= signal_at),
      CHECK(tg_observed_at <= signal_at)
    );
    CREATE INDEX IF NOT EXISTS idx_fomo_snapshots_token_time
      ON fomo_score_snapshots(canonical_token_id, signal_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fomo_snapshots_time
      ON fomo_score_snapshots(signal_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fomo_snapshots_version_time
      ON fomo_score_snapshots(score_version, signal_at DESC);
  `);
}
