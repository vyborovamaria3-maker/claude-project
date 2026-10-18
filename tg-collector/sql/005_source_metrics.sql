-- UTC publication-day activity statistics; observed views are snapshots, not unique visitors.
CREATE TABLE IF NOT EXISTS tg_source_daily_metrics (
  source_id BIGINT NOT NULL REFERENCES tg_sources(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  posts_count INTEGER NOT NULL CHECK(posts_count > 0),
  views_total BIGINT NOT NULL DEFAULT 0,
  views_count INTEGER NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,day)
);
CREATE INDEX IF NOT EXISTS tg_source_daily_metrics_day_idx
  ON tg_source_daily_metrics(day DESC,source_id);
