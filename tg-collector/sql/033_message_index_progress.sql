-- Paging past false-positive keyword substrings must survive worker restarts.
-- A settings change resets the scan so newly entered terms are not lost.
CREATE TABLE IF NOT EXISTS tg_message_index_progress (
  id integer PRIMARY KEY CHECK(id=1),
  term_signature text NOT NULL DEFAULT '',
  sort_date timestamptz,
  sort_source_id bigint,
  sort_message_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tg_message_index_progress(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
