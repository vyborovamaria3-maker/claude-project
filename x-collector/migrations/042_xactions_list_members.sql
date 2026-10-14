-- List membership observations are distinct from global twitter_profiles.
-- Membership is observed, not guaranteed to represent the complete list.
CREATE TABLE IF NOT EXISTS xc_list_member_observations (
  list_id text NOT NULL CHECK (list_id ~ '^[0-9]{1,25}$'),
  handle text NOT NULL CHECK (handle ~ '^[A-Za-z0-9_]{1,15}$'),
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  last_task_id bigint REFERENCES x_tasks(id) ON DELETE SET NULL,
  PRIMARY KEY (list_id, handle),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS xc_list_member_observations_handle_idx
  ON xc_list_member_observations (handle, last_seen_at DESC);

-- This operation is available only in opt-in XActions mode.
ALTER TABLE x_tasks DROP CONSTRAINT IF EXISTS x_tasks_kind_check;
ALTER TABLE x_tasks ADD CONSTRAINT x_tasks_kind_check
  CHECK (kind IN ('search','timeline','profile','members'));
