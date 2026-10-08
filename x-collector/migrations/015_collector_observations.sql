-- New observations preserve unknown metrics and historical changes.
-- Existing zero values are retained: their provenance cannot be reconstructed.
ALTER TABLE twitter_tweets ALTER COLUMN views DROP NOT NULL, ALTER COLUMN views DROP DEFAULT,
 ALTER COLUMN likes DROP NOT NULL, ALTER COLUMN likes DROP DEFAULT,
 ALTER COLUMN retweets DROP NOT NULL, ALTER COLUMN retweets DROP DEFAULT,
 ALTER COLUMN replies DROP NOT NULL, ALTER COLUMN replies DROP DEFAULT;
CREATE TABLE IF NOT EXISTS twitter_tweet_observations (
 tweet_id text NOT NULL REFERENCES twitter_tweets(tweet_id) ON DELETE CASCADE,
 observed_at timestamptz NOT NULL, raw jsonb NOT NULL,
 PRIMARY KEY(tweet_id,observed_at)
);
CREATE INDEX IF NOT EXISTS idx_tweet_observations_time ON twitter_tweet_observations(observed_at);
CREATE TABLE IF NOT EXISTS twitter_profile_observations (
 handle text NOT NULL REFERENCES twitter_profiles(handle) ON DELETE CASCADE,
 observed_at timestamptz NOT NULL, raw jsonb NOT NULL,
 PRIMARY KEY(handle,observed_at)
);
CREATE INDEX IF NOT EXISTS idx_profile_observations_time ON twitter_profile_observations(observed_at);
CREATE TABLE IF NOT EXISTS twitter_entity_links (
 tweet_id text NOT NULL REFERENCES twitter_tweets(tweet_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('mention_handle','hashtag','url','visible_post_reference','media_photo','media_video')),
 value text NOT NULL, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
 PRIMARY KEY(tweet_id,kind,value)
);
CREATE INDEX IF NOT EXISTS idx_twitter_entities_lookup ON twitter_entity_links(kind,value,tweet_id);
