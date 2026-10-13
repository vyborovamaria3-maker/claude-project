-- Opt-in staged collection: chosen lists and their author archive precede discovery.
CREATE TABLE IF NOT EXISTS xc_discovery_plan (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 list_ids jsonb NOT NULL DEFAULT '[]', history_run_id text REFERENCES xc_history_runs(id),
 max_browser_accounts integer NOT NULL DEFAULT 1 CHECK(max_browser_accounts BETWEEN 1 AND 10),
 message text, updated_at bigint NOT NULL DEFAULT 0
);
INSERT INTO xc_discovery_plan(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS xc_discovery_sources (
 name text PRIMARY KEY, query text NOT NULL CHECK(length(query) BETWEEN 1 AND 350),
 enabled boolean NOT NULL DEFAULT true, interval_minutes integer NOT NULL DEFAULT 60 CHECK(interval_minutes>=15),
 next_run bigint NOT NULL DEFAULT 0, last_seen_id text NOT NULL DEFAULT '',
 pending_head_id text NOT NULL DEFAULT '', cursor_id text NOT NULL DEFAULT '',
 task_id bigint REFERENCES x_tasks(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','queued','partial')),
 message text, last_completed_at bigint, updated_at bigint NOT NULL DEFAULT 0
);
