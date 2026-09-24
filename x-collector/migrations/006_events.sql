CREATE TABLE IF NOT EXISTS mint_events (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  detected_at BIGINT NOT NULL,
  event_at BIGINT,
  payload JSONB,
  source TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_me_mint_time ON mint_events(mint, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_me_type_time ON mint_events(event_type, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_me_severity ON mint_events(severity DESC, detected_at DESC);

CREATE TABLE IF NOT EXISTS mint_milestones (
  mint TEXT NOT NULL,
  milestone TEXT NOT NULL,
  value BIGINT,
  reached_at BIGINT NOT NULL,
  PRIMARY KEY (mint, milestone)
);
CREATE INDEX IF NOT EXISTS idx_mm_milestone ON mint_milestones(milestone, reached_at DESC);

DROP MATERIALIZED VIEW IF EXISTS mv_mint_first_movers CASCADE;
CREATE MATERIALIZED VIEW mv_mint_first_movers AS
WITH ranked AS (
  SELECT l.mint, t.handle, t.tweet_id, t.posted_at, t.views, t.is_verified,
    ROW_NUMBER() OVER (PARTITION BY l.mint ORDER BY t.posted_at ASC NULLS LAST) AS rn
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  WHERE t.posted_at IS NOT NULL
)
SELECT mint,
  MIN(posted_at) AS first_mention_at,
  MAX(CASE WHEN rn = 1 THEN handle END) AS first_author,
  MAX(CASE WHEN rn = 1 THEN tweet_id END) AS first_tweet_id,
  MAX(CASE WHEN rn = 2 THEN handle END) AS second_author,
  MAX(CASE WHEN rn = 3 THEN handle END) AS third_author,
  MAX(CASE WHEN rn <= 5 AND is_verified THEN handle END) AS first_verified_kol
FROM ranked WHERE rn <= 10
GROUP BY mint;
CREATE UNIQUE INDEX IF NOT EXISTS mv_mfm_pk ON mv_mint_first_movers(mint);

DROP VIEW IF EXISTS v_mint_timeline CASCADE;
CREATE VIEW v_mint_timeline AS
SELECT me.mint, me.detected_at, me.event_type, me.severity, me.notes, me.payload,
  s.total_tweets AS tweets_at_event, s.unique_authors AS authors_at_event
FROM mint_events me
LEFT JOIN v_mint_summary s ON s.mint = me.mint
ORDER BY me.detected_at DESC;

CREATE OR REPLACE FUNCTION check_milestones() RETURNS TRIGGER AS $$
DECLARE cnt INTEGER; has_verified BOOLEAN;
BEGIN
  SELECT COUNT(DISTINCT t.tweet_id), BOOL_OR(t.is_verified)
  INTO cnt, has_verified
  FROM tweet_token_links l
  JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
  WHERE l.mint = NEW.mint;

  INSERT INTO mint_milestones (mint, milestone, value, reached_at)
  VALUES (NEW.mint, 'first_10_tweets', cnt, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
  ON CONFLICT (mint, milestone) DO NOTHING;

  IF cnt >= 100 THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_100_tweets', cnt, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;

  IF cnt >= 1000 THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_1000_tweets', cnt, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;

  IF has_verified THEN
    INSERT INTO mint_milestones (mint, milestone, value, reached_at)
    VALUES (NEW.mint, 'first_verified', 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT (mint, milestone) DO NOTHING;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_milestones ON tweet_token_links;
CREATE TRIGGER trg_milestones AFTER INSERT ON tweet_token_links FOR EACH ROW EXECUTE FUNCTION check_milestones();

CREATE OR REPLACE FUNCTION detect_viral_events() RETURNS INTEGER AS $$
DECLARE cnt INTEGER := 0; rec RECORD;
BEGIN
  FOR rec IN
    SELECT mint, hour_bucket, tweets FROM (
      SELECT l.mint, (t.posted_at / 3600000)::BIGINT AS hour_bucket,
        COUNT(DISTINCT t.tweet_id) AS tweets
      FROM tweet_token_links l
      JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
      WHERE t.posted_at > (EXTRACT(EPOCH FROM NOW()) * 1000 - 86400000)::BIGINT
      GROUP BY l.mint, hour_bucket
    ) x WHERE x.tweets >= 100
  LOOP
    INSERT INTO mint_events (mint, event_type, severity, detected_at, event_at, source, payload)
    VALUES (rec.mint, 'viral', 4,
      (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      rec.hour_bucket * 3600000, 'auto',
      jsonb_build_object('tweets_in_hour', rec.tweets));
    cnt := cnt + 1;
  END LOOP;
  RETURN cnt;
END $$ LANGUAGE plpgsql;

