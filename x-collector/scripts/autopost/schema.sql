CREATE TABLE IF NOT EXISTS xc_ai_providers (
 id text PRIMARY KEY, label text NOT NULL, protocol text NOT NULL CHECK(protocol IN ('openai','anthropic','gemini','ollama','custom')),
 endpoint text NOT NULL, model text NOT NULL, secret bytea, adapter text, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS xc_auto_config (
 account_name text PRIMARY KEY REFERENCES x_accounts(name) ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT false,
 expected_handle text NOT NULL, provider_id text REFERENCES xc_ai_providers(id), language text NOT NULL DEFAULT 'ru',
 style text NOT NULL DEFAULT 'Короткие наблюдения о мемкоинах Solana с указанием источника.',
 kinds jsonb NOT NULL DEFAULT '["post"]', interval_minutes int NOT NULL DEFAULT 120 CHECK(interval_minutes BETWEEN 5 AND 10080),
 daily_limit int NOT NULL DEFAULT 4 CHECK(daily_limit BETWEEN 1 AND 100), start_hour int NOT NULL DEFAULT 9 CHECK(start_hour BETWEEN 0 AND 23),
 end_hour int NOT NULL DEFAULT 23 CHECK(end_hour BETWEEN 0 AND 23), next_run bigint NOT NULL DEFAULT 0, last_message text,
 updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS xc_auto_control (id int PRIMARY KEY CHECK(id=1),paused boolean NOT NULL DEFAULT true,heartbeat bigint);
INSERT INTO xc_auto_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS xc_auto_jobs (
 id text PRIMARY KEY,account_name text NOT NULL,expected_handle text NOT NULL,kind text NOT NULL CHECK(kind IN ('post','reply','like','repost','follow')),
 content text, target_id text,target_handle text,evidence jsonb NOT NULL DEFAULT '[]',reason text NOT NULL DEFAULT '',provider_id text,
 dedup text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','published','failed','uncertain','cancelled')),
 attempted boolean NOT NULL DEFAULT false,retry_count integer NOT NULL DEFAULT 0,scheduled_at bigint NOT NULL,created_at bigint NOT NULL,started_at bigint,finished_at bigint,
 lease_until bigint,result_id text,result_url text,message text,origin text NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS xc_auto_jobs_due ON xc_auto_jobs(status,scheduled_at);
CREATE INDEX IF NOT EXISTS xc_auto_jobs_account ON xc_auto_jobs(account_name,created_at DESC);
CREATE TABLE IF NOT EXISTS xc_auto_posts (
 tweet_id text PRIMARY KEY,account_name text NOT NULL,handle text NOT NULL,text text NOT NULL,url text NOT NULL,
 posted_at bigint NOT NULL,views bigint,likes bigint,replies bigint,retweets bigint,updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS xc_auto_posts_account ON xc_auto_posts(account_name,posted_at DESC);
CREATE TABLE IF NOT EXISTS xc_auto_metrics (
 tweet_id text NOT NULL REFERENCES xc_auto_posts(tweet_id) ON DELETE CASCADE,measured_at bigint NOT NULL,
 views bigint,likes bigint,replies bigint,retweets bigint,PRIMARY KEY(tweet_id,measured_at)
);
CREATE TABLE IF NOT EXISTS xc_auto_sync (
 id text PRIMARY KEY,account_name text NOT NULL,expected_handle text NOT NULL,tweet_id text NOT NULL,
 status text NOT NULL DEFAULT 'queued',message text,created_at bigint NOT NULL,finished_at bigint
);

ALTER TABLE xc_auto_jobs ADD COLUMN IF NOT EXISTS attempted_at bigint;
ALTER TABLE xc_auto_jobs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS xc_auto_sources (
 list_id text PRIMARY KEY CHECK(list_id ~ '^[0-9]{1,25}$'),
 enabled boolean NOT NULL DEFAULT true,
 interval_minutes int NOT NULL DEFAULT 15 CHECK(interval_minutes BETWEEN 5 AND 1440),
 next_run bigint NOT NULL DEFAULT 0,
 last_task_id bigint REFERENCES x_tasks(id)
);


CREATE TABLE IF NOT EXISTS xc_auto_reconcile (
 job_id text PRIMARY KEY REFERENCES xc_auto_jobs(id) ON DELETE CASCADE,
 account_name text NOT NULL,
 expected_handle text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('post','reply','like','repost','follow')),
 attempted_at bigint NOT NULL,
 first_checked_at bigint,
 next_check_at bigint NOT NULL,
 deadline_at bigint NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','resolved','manual_review','manual_required')),
 matched_tweet_id text,
 candidates jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(candidates)='array'),
 last_error text,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 finished_at bigint,
 CHECK(deadline_at >= attempted_at)
);
CREATE INDEX IF NOT EXISTS xc_auto_reconcile_due ON xc_auto_reconcile(next_check_at,created_at) WHERE status='queued';
CREATE INDEX IF NOT EXISTS xc_auto_reconcile_account ON xc_auto_reconcile(account_name,status,updated_at DESC);


-- V2-01: this is a forward-only audit for transitions committed AFTER deployment.
-- Legacy rows are not retroactively labeled as confirmed or attempted.
CREATE TABLE IF NOT EXISTS xc_auto_job_attempts (
 attempt_id text PRIMARY KEY,
 job_id text NOT NULL REFERENCES xc_auto_jobs(id) ON DELETE RESTRICT,
 attempt_no integer NOT NULL CHECK (attempt_no > 0),
 started_at bigint NOT NULL,
 boundary_at bigint,
 finished_at bigint,
 status text NOT NULL CHECK (status IN ('claimed','boundary_recorded','retry_scheduled','uncertain','published','failed','cancelled')),
 error_category text CHECK (error_category IS NULL OR error_category IN ('X_ERROR','DB_ERROR','VALIDATION_ERROR','PROCESS_ERROR')),
 error_code text,
 trace_id text NOT NULL,
 UNIQUE(job_id,attempt_no)
);
CREATE INDEX IF NOT EXISTS xc_auto_job_attempts_recent ON xc_auto_job_attempts(job_id,attempt_no DESC);

CREATE TABLE IF NOT EXISTS xc_auto_job_events (
 event_id bigserial PRIMARY KEY,
 job_id text NOT NULL REFERENCES xc_auto_jobs(id) ON DELETE RESTRICT,
 attempt_id text REFERENCES xc_auto_job_attempts(attempt_id) ON DELETE RESTRICT,
 event_type text NOT NULL,
 occurred_at bigint NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS xc_auto_job_events_by_job ON xc_auto_job_events(job_id,event_id);
CREATE INDEX IF NOT EXISTS xc_auto_job_events_by_attempt ON xc_auto_job_events(attempt_id,event_id) WHERE attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION xc_auto_job_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Autopost audit events are append-only' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS xc_auto_events_immutable ON xc_auto_job_events;
CREATE TRIGGER xc_auto_events_immutable BEFORE UPDATE OR DELETE ON xc_auto_job_events
FOR EACH ROW EXECUTE FUNCTION xc_auto_job_events_append_only();
DROP TRIGGER IF EXISTS xc_auto_events_no_truncate ON xc_auto_job_events;
CREATE TRIGGER xc_auto_events_no_truncate BEFORE TRUNCATE ON xc_auto_job_events
FOR EACH STATEMENT EXECUTE FUNCTION xc_auto_job_events_append_only();

-- AFTER triggers guarantee that job transitions and their audit rows have
-- the same PostgreSQL commit/rollback even for old runtime call sites.
CREATE OR REPLACE FUNCTION xc_auto_job_audit_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
 ts bigint;
 active_id text;
 next_attempt integer;
 event_kind text;
 category text;
 code text;
BEGIN
 ts := floor(extract(epoch from clock_timestamp())*1000)::bigint;
 IF TG_OP='INSERT' THEN
   INSERT INTO xc_auto_job_events(job_id,event_type,occurred_at,payload)
   VALUES(NEW.id,'created',COALESCE(NEW.created_at,ts),
          jsonb_build_object('status',NEW.status,'origin',NEW.origin));
   RETURN NEW;
 END IF;
 IF NEW.status=OLD.status AND NEW.attempted IS NOT DISTINCT FROM OLD.attempted THEN
   RETURN NEW;
 END IF;

 IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status='running' THEN
   SELECT COALESCE(max(attempt_no),0)+1 INTO next_attempt FROM xc_auto_job_attempts WHERE job_id=NEW.id;
   active_id := gen_random_uuid()::text;
   INSERT INTO xc_auto_job_attempts(attempt_id,job_id,attempt_no,started_at,status,trace_id)
   VALUES(active_id,NEW.id,next_attempt,COALESCE(NEW.started_at,ts),'claimed',gen_random_uuid()::text);
 ELSE
   SELECT attempt_id INTO active_id FROM xc_auto_job_attempts
   WHERE job_id=NEW.id ORDER BY attempt_no DESC LIMIT 1;
 END IF;

 IF OLD.attempted IS DISTINCT FROM NEW.attempted AND NEW.attempted THEN
   UPDATE xc_auto_job_attempts
   SET boundary_at=COALESCE(NEW.attempted_at,ts),status='boundary_recorded'
   WHERE attempt_id=active_id AND status='claimed';
   INSERT INTO xc_auto_job_events(job_id,attempt_id,event_type,occurred_at,payload)
   VALUES(NEW.id,active_id,'boundary_recorded',COALESCE(NEW.attempted_at,ts),
          jsonb_build_object('attempted',true));
 END IF;

 IF OLD.status IS DISTINCT FROM NEW.status THEN
   event_kind := CASE
     WHEN NEW.status='running' THEN 'claimed'
     WHEN OLD.status='uncertain' AND NEW.status='queued' THEN 'manual_retry_approved'
     WHEN NEW.status='queued' THEN 'retry_scheduled'
     WHEN NEW.status='uncertain' THEN 'uncertain'
     WHEN NEW.status='published' THEN 'published'
     WHEN NEW.status='failed' THEN 'failed'
     WHEN NEW.status='cancelled' THEN 'cancelled'
     ELSE 'state_changed' END;
   IF OLD.status='running' AND NEW.status IN ('queued','uncertain','published','failed','cancelled') THEN
     UPDATE xc_auto_job_attempts
     SET status=CASE NEW.status WHEN 'queued' THEN 'retry_scheduled' ELSE NEW.status END,
         finished_at=COALESCE(NEW.finished_at,ts)
     WHERE attempt_id=active_id AND status IN ('claimed','boundary_recorded');
   ELSIF OLD.status='uncertain' AND NEW.status='published' THEN
     UPDATE xc_auto_job_attempts
     SET status='published',finished_at=COALESCE(NEW.finished_at,ts)
     WHERE attempt_id=active_id AND status='uncertain';
   END IF;
   INSERT INTO xc_auto_job_events(job_id,attempt_id,event_type,occurred_at,payload)
   VALUES(NEW.id,active_id,event_kind,ts,
          jsonb_build_object('from',OLD.status,'to',NEW.status,
                             'retry_count',NEW.retry_count,
                             'attempted',NEW.attempted));
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS xc_auto_jobs_audit ON xc_auto_jobs;
CREATE TRIGGER xc_auto_jobs_audit
AFTER INSERT OR UPDATE OF status,attempted,attempted_at ON xc_auto_jobs
FOR EACH ROW EXECUTE FUNCTION xc_auto_job_audit_transition();
