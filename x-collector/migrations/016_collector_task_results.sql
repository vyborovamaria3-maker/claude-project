-- Result attribution is transactional with collection, never inferred from query text.
CREATE TABLE IF NOT EXISTS x_task_tweets (
 task_id bigint NOT NULL REFERENCES x_tasks(id) ON DELETE CASCADE,
 tweet_id text NOT NULL REFERENCES twitter_tweets(tweet_id) ON DELETE CASCADE,
 PRIMARY KEY(task_id,tweet_id)
);
CREATE TABLE IF NOT EXISTS x_task_profiles (
 task_id bigint NOT NULL REFERENCES x_tasks(id) ON DELETE CASCADE,
 handle text NOT NULL REFERENCES twitter_profiles(handle) ON DELETE CASCADE,
 PRIMARY KEY(task_id,handle)
);
