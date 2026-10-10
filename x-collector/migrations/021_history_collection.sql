CREATE TABLE IF NOT EXISTS xc_history_runs (
 id text PRIMARY KEY,
 account_name text REFERENCES x_accounts(name) ON DELETE SET NULL,
 since_date date NOT NULL,
 until_date date NOT NULL,
 topics_json jsonb NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','finished')),
 message text,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 CHECK(since_date < until_date)
);
CREATE TABLE IF NOT EXISTS xc_history_lists (
 run_id text NOT NULL REFERENCES xc_history_runs(id) ON DELETE CASCADE,
 list_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
 attempts int NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id,list_id)
);
CREATE TABLE IF NOT EXISTS xc_history_authors (
 run_id text NOT NULL REFERENCES xc_history_runs(id) ON DELETE CASCADE,
 list_id text NOT NULL,
 handle text NOT NULL,
 PRIMARY KEY(run_id,list_id,handle)
);
CREATE TABLE IF NOT EXISTS xc_history_windows (
 id bigserial PRIMARY KEY,
 run_id text NOT NULL REFERENCES xc_history_runs(id) ON DELETE CASCADE,
 base_query text NOT NULL,
 author_handle text,
 since_date date NOT NULL,
 until_date date NOT NULL,
 cursor_id text NOT NULL DEFAULT '',
 task_id bigint REFERENCES x_tasks(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','done','failed','partial')),
 message text,
 UNIQUE(run_id,base_query,since_date,until_date),
 CHECK(since_date < until_date)
);
CREATE TABLE IF NOT EXISTS xc_history_tasks (
 window_id bigint NOT NULL REFERENCES xc_history_windows(id) ON DELETE CASCADE,
 task_id bigint NOT NULL REFERENCES x_tasks(id) ON DELETE CASCADE,
 PRIMARY KEY(window_id,task_id)
);
CREATE INDEX IF NOT EXISTS xc_history_windows_pending ON xc_history_windows(run_id,status,id);
