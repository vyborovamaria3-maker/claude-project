CREATE TABLE IF NOT EXISTS x_task_progress (
 task_id bigint PRIMARY KEY REFERENCES x_tasks(id) ON DELETE CASCADE,
 worker_id text NOT NULL, attempt integer NOT NULL,
 account_name text, phase text NOT NULL,
 found integer NOT NULL DEFAULT 0 CHECK(found>=0),
 authors jsonb NOT NULL DEFAULT '[]'::jsonb,
 current_author text, target_limit integer,
 started_at bigint NOT NULL, updated_at bigint NOT NULL
);
