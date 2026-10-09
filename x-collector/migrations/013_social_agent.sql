ALTER TABLE x_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'collector' CHECK (role IN ('collector','publisher'));
CREATE INDEX x_accounts_role_status ON x_accounts(role,status);
CREATE TABLE social_agent_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  stopped BOOLEAN NOT NULL DEFAULT TRUE,
  max_actions_per_cycle INTEGER NOT NULL DEFAULT 3 CHECK(max_actions_per_cycle BETWEEN 1 AND 10),
  max_actions_per_day INTEGER NOT NULL DEFAULT 12 CHECK(max_actions_per_day BETWEEN 1 AND 100),
  updated_at BIGINT NOT NULL
);
INSERT INTO social_agent_settings(id,updated_at) VALUES(1,0);
CREATE TABLE social_agent_actions (
  id BIGSERIAL PRIMARY KEY,
  account_name TEXT NOT NULL REFERENCES x_accounts(name),
  kind TEXT NOT NULL CHECK(kind IN ('post','reply','repost','like','follow')),
  tweet_id TEXT NOT NULL REFERENCES twitter_tweets(tweet_id),
  status TEXT NOT NULL CHECK(status IN ('simulated','blocked')),
  content TEXT,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  provider TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(kind,tweet_id)
);
CREATE INDEX social_agent_actions_recent ON social_agent_actions(created_at DESC);
CREATE FUNCTION enforce_publisher_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM x_accounts WHERE name=NEW.account_name AND role='publisher' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Social actions require a publisher account'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER social_actions_publisher BEFORE INSERT OR UPDATE ON social_agent_actions
FOR EACH ROW EXECUTE FUNCTION enforce_publisher_role();
