-- Bounded, redacted stage evidence. No page text, URLs, session data or
-- arbitrary exception strings are accepted into this table.
CREATE TABLE IF NOT EXISTS xc_task_events (
 id bigserial PRIMARY KEY,
 task_id bigint NOT NULL REFERENCES x_tasks(id) ON DELETE CASCADE,
 worker_id text NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 200),
 attempt integer NOT NULL CHECK(attempt>=0),
 stage text NOT NULL CHECK(stage IN
  ('selecting','opening','collecting','saving','waiting','unverified_end',
   'finishing','failed','checkpoint')),
 account_name text,
 observed_count integer CHECK(observed_count IS NULL OR observed_count>=0),
 created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS xc_task_events_task_idx
  ON xc_task_events(task_id,id DESC);
CREATE INDEX IF NOT EXISTS xc_task_events_old_idx
  ON xc_task_events(created_at);
