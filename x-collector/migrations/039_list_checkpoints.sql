CREATE TABLE IF NOT EXISTS xc_list_checkpoints (
 list_id text PRIMARY KEY CHECK(list_id ~ '^[0-9]{1,25}$'),
 last_seen_id text NOT NULL DEFAULT '',
 pending_head_id text NOT NULL DEFAULT '',
 cursor_id text NOT NULL DEFAULT '',
 task_id bigint REFERENCES x_tasks(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','queued','partial')),
 message text,
 last_completed_at bigint,
 updated_at bigint NOT NULL DEFAULT 0
);
