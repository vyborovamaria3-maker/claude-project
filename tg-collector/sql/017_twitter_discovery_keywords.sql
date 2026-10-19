ALTER TABLE tg_discovery_settings
 ADD COLUMN auto_keywords_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN auto_keywords_limit integer NOT NULL DEFAULT 12 CHECK(auto_keywords_limit BETWEEN 1 AND 30),
 ADD COLUMN twitter_lookback_hours integer NOT NULL DEFAULT 72 CHECK(twitter_lookback_hours BETWEEN 1 AND 168),
 ADD COLUMN twitter_tweet_limit integer NOT NULL DEFAULT 2000 CHECK(twitter_tweet_limit BETWEEN 100 AND 5000),
 ADD COLUMN min_keyword_posts integer NOT NULL DEFAULT 3 CHECK(min_keyword_posts BETWEEN 2 AND 20),
 ADD COLUMN min_keyword_authors integer NOT NULL DEFAULT 2 CHECK(min_keyword_authors BETWEEN 1 AND 10),
 ADD COLUMN generated_keywords text[] NOT NULL DEFAULT '{}',
 ADD COLUMN keyword_stats jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN keyword_refreshed_at timestamptz,
 ADD COLUMN keyword_post_count integer NOT NULL DEFAULT 0,
 ADD COLUMN keyword_error_code text;
ALTER TABLE tg_discovery_settings DROP CONSTRAINT tg_discovery_settings_keywords_check;
ALTER TABLE tg_discovery_settings ADD CONSTRAINT tg_discovery_keywords_count CHECK(cardinality(keywords) BETWEEN 0 AND 30);
ALTER TABLE tg_discovery_settings ADD CONSTRAINT tg_discovery_keywords_mode CHECK(auto_keywords_enabled OR cardinality(keywords)>0);
