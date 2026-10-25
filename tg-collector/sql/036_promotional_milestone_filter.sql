-- Screening is source-level, not destructive message deletion. Each source
-- gets one bounded preview of up to 120 latest public posts before backfill.
-- Screening runs only with TG_PROMOTIONAL_SCREENING_ENABLED=true.
ALTER TABLE tg_sources
  ADD COLUMN IF NOT EXISTS spam_kind TEXT
    CONSTRAINT tg_sources_spam_kind_check
    CHECK (spam_kind IS NULL OR spam_kind='promotional_milestone'),
  ADD COLUMN IF NOT EXISTS spam_screened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spam_sample_size INTEGER NOT NULL DEFAULT 0
    CHECK (spam_sample_size >= 0 AND spam_sample_size <= 120),
  ADD COLUMN IF NOT EXISTS spam_match_count INTEGER NOT NULL DEFAULT 0
    CHECK (spam_match_count >= 0 AND spam_match_count <= 120),
  ADD COLUMN IF NOT EXISTS spam_reason TEXT;

-- The archive and its raw evidence remain intact even for blocked channels.
-- No historical messages are deleted and no third-party RPC is invoked.
CREATE INDEX IF NOT EXISTS tg_sources_spam_kind_idx
  ON tg_sources(spam_kind) WHERE spam_kind IS NOT NULL;
