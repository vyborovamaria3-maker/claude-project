-- ЗАВИСИТ ОТ: 001, 002, 004

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable; embedding storage will be skipped: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS tweet_sentiment (
  tweet_id TEXT PRIMARY KEY,
  score NUMERIC(5,4) NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('bearish','neutral','bullish')),
  magnitude NUMERIC(5,4),
  confidence NUMERIC(5,4),
  model TEXT NOT NULL DEFAULT 'lexicon-v1',
  tokens INTEGER NOT NULL DEFAULT 0,
  scored_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sent_label ON tweet_sentiment(label, score DESC);
CREATE INDEX IF NOT EXISTS idx_sent_score ON tweet_sentiment(score DESC);

CREATE TABLE IF NOT EXISTS tweet_entities (
  id BIGSERIAL PRIMARY KEY,
  tweet_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  value TEXT NOT NULL,
  position INTEGER,
  confidence NUMERIC(5,4),
  extracted_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ent_tweet ON tweet_entities(tweet_id);
CREATE INDEX IF NOT EXISTS idx_ent_type_val ON tweet_entities(entity_type, value);
CREATE INDEX IF NOT EXISTS idx_ent_value ON tweet_entities(value);

DO $$ BEGIN
  IF to_regtype('vector') IS NULL THEN
    RAISE NOTICE 'pgvector type is unavailable; skipping tweet_embeddings';
  ELSE
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS tweet_embeddings (
        tweet_id TEXT PRIMARY KEY,
        model TEXT NOT NULL DEFAULT 'minilm-l6',
        embedding vector(384),
        dim INTEGER NOT NULL DEFAULT 384,
        created_at BIGINT NOT NULL
      )
    $ddl$;
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_emb_hnsw ON tweet_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)';
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_emb_ivfflat ON tweet_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'vector index unavailable: %', SQLERRM;
      END;
    END;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  keywords TEXT[] NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tweet_topics (
  tweet_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  probability NUMERIC(5,4) NOT NULL,
  PRIMARY KEY (tweet_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_tt_topic ON tweet_topics(topic_id, probability DESC);

CREATE TABLE IF NOT EXISTS tweet_toxicity (
  tweet_id TEXT PRIMARY KEY,
  toxicity NUMERIC(5,4) NOT NULL DEFAULT 0,
  spam_score NUMERIC(5,4) NOT NULL DEFAULT 0,
  scam_score NUMERIC(5,4) NOT NULL DEFAULT 0,
  adult_score NUMERIC(5,4) NOT NULL DEFAULT 0,
  score_model TEXT NOT NULL DEFAULT 'heuristic-v1',
  scored_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tox_spam ON tweet_toxicity(spam_score DESC);
CREATE INDEX IF NOT EXISTS idx_tox_scam ON tweet_toxicity(scam_score DESC);

CREATE TABLE IF NOT EXISTS tweet_languages (
  tweet_id TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  confidence NUMERIC(5,4),
  detected_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lang ON tweet_languages(lang);

DROP MATERIALIZED VIEW IF EXISTS mv_mint_sentiment_daily CASCADE;
CREATE MATERIALIZED VIEW mv_mint_sentiment_daily AS
SELECT l.mint,
  to_char(to_timestamp(t.posted_at / 1000), 'YYYY-MM-DD') AS day,
  COUNT(*)::INT AS tweets,
  ROUND(AVG(s.score), 4) AS avg_sentiment,
  ROUND(STDDEV_POP(s.score), 4) AS stddev_sentiment,
  COUNT(*) FILTER (WHERE s.label = 'bullish')::INT AS bullish,
  COUNT(*) FILTER (WHERE s.label = 'neutral')::INT AS neutral,
  COUNT(*) FILTER (WHERE s.label = 'bearish')::INT AS bearish,
  COUNT(*) FILTER (WHERE tox.toxicity > 0.5)::INT AS toxic,
  COUNT(*) FILTER (WHERE tox.spam_score > 0.7)::INT AS spam
FROM tweet_token_links l
JOIN twitter_tweets t ON t.tweet_id = l.tweet_id
LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
LEFT JOIN tweet_toxicity tox ON tox.tweet_id = t.tweet_id
WHERE t.posted_at IS NOT NULL
GROUP BY l.mint, day;
CREATE UNIQUE INDEX IF NOT EXISTS mv_msd_pk ON mv_mint_sentiment_daily(mint, day);
CREATE INDEX IF NOT EXISTS mv_msd_mint ON mv_mint_sentiment_daily(mint, day DESC);

CREATE OR REPLACE FUNCTION scan_tweet_toxicity(p_text TEXT)
RETURNS TABLE(toxicity NUMERIC, spam_score NUMERIC, scam_score NUMERIC) AS $$
DECLARE
  txt TEXT := lower(COALESCE(p_text, ''));
  t NUMERIC := 0; s NUMERIC := 0; sc NUMERIC := 0;
BEGIN
  IF txt ~ '\y(guaranteed|100%|risk.?free|send\s+(sol|eth|btc))\y' THEN sc := sc + 0.5; END IF;
  IF txt ~ '\y(double\s+your|passive\s+income|free\s+money)\y' THEN sc := sc + 0.4; END IF;
  IF txt ~ '\y(dm\s+me|pm\s+me|telegram|whatsapp)\y.*\y(profit|signal|pump)\y' THEN sc := sc + 0.5; END IF;
  IF txt ~ '\y(airdrop|whitelist|presale).*\y(click|join|claim)\y' THEN sc := sc + 0.3; END IF;
  IF txt ~ '(🚀{3,}|💎{3,}|🌙{3,}|🔥{3,}|💰{3,})' THEN s := s + 0.3; END IF;
  IF txt ~ '\y(100x|1000x|moonshot|to the moon|dont fade|don.t fade)\y' THEN s := s + 0.3; END IF;
  IF txt ~ '@\w+.*@\w+.*@\w+.*@\w+' THEN s := s + 0.4; END IF;
  IF txt ~ '#\w+.*#\w+.*#\w+.*#\w+.*#\w+' THEN s := s + 0.3; END IF;
  IF length(regexp_replace(txt, '[^a-z]', '', 'g')) < 10 AND txt ~ '\y(buy|sell|pump|moon|gem)\y' THEN s := s + 0.5; END IF;
  IF txt ~ '\y(scam|rug|honeypot|fraud|stolen|hacked)\y' THEN t := t + 0.3; END IF;
  IF txt ~ '\y(idiot|stupid|moron|fool|clown)\y' THEN t := t + 0.5; END IF;
  IF txt ~ '\y(fuck|shit|damn|bastard)\y' THEN t := t + 0.4; END IF;
  toxicity := LEAST(t, 1.0);
  spam_score := LEAST(s, 1.0);
  scam_score := LEAST(sc, 1.0);
  RETURN NEXT;
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS sentiment_lexicon (
  word TEXT PRIMARY KEY,
  score NUMERIC(4,3) NOT NULL,
  category TEXT
);

INSERT INTO sentiment_lexicon (word, score, category) VALUES
  ('moon', 0.9, 'bull'), ('bullish', 0.9, 'bull'), ('pump', 0.8, 'bull'),
  ('gem', 0.85, 'bull'), ('alpha', 0.7, 'bull'), ('ath', 0.9, 'bull'),
  ('send', 0.6, 'bull'), ('rocket', 0.8, 'bull'), ('breakout', 0.75, 'bull'),
  ('launch', 0.5, 'bull'), ('buy', 0.6, 'bull'), ('hold', 0.5, 'bull'),
  ('diamond', 0.7, 'bull'), ('hodl', 0.7, 'bull'), ('based', 0.6, 'bull'),
  ('wagmi', 0.6, 'bull'), ('surge', 0.7, 'bull'),
  ('rug', -0.95, 'bear'), ('scam', -0.9, 'bear'), ('dump', -0.8, 'bear'),
  ('bearish', -0.9, 'bear'), ('crash', -0.85, 'bear'), ('dead', -0.7, 'bear'),
  ('honeypot', -0.95, 'bear'), ('fud', -0.6, 'bear'), ('ponzi', -0.9, 'bear'),
  ('exit', -0.5, 'bear'), ('sell', -0.5, 'bear'), ('warn', -0.4, 'bear'),
  ('fake', -0.7, 'bear'), ('steal', -0.9, 'bear'), ('stolen', -0.9, 'bear')
ON CONFLICT (word) DO NOTHING;

CREATE OR REPLACE FUNCTION score_sentiment(p_text TEXT)
RETURNS NUMERIC AS $$
DECLARE
  words TEXT[];
  w TEXT;
  total NUMERIC := 0;
  cnt INTEGER := 0;
  s NUMERIC;
BEGIN
  words := regexp_split_to_array(lower(COALESCE(p_text, '')), '[^a-z0-9]+');
  FOREACH w IN ARRAY words LOOP
    IF length(w) < 3 THEN CONTINUE; END IF;
    SELECT score INTO s FROM sentiment_lexicon WHERE word = w;
    IF s IS NOT NULL THEN total := total + s; cnt := cnt + 1; END IF;
  END LOOP;
  IF cnt = 0 THEN RETURN 0; END IF;
  RETURN ROUND(total / GREATEST(cnt, 1)::NUMERIC, 4);
END $$ LANGUAGE plpgsql IMMUTABLE;

DROP MATERIALIZED VIEW IF EXISTS mv_author_sentiment CASCADE;
CREATE MATERIALIZED VIEW mv_author_sentiment AS
SELECT t.handle,
  COUNT(*)::INT AS tweets_scored,
  ROUND(AVG(s.score), 4) AS avg_sentiment,
  COUNT(*) FILTER (WHERE s.label = 'bullish')::INT AS bullish,
  COUNT(*) FILTER (WHERE s.label = 'bearish')::INT AS bearish,
  COUNT(*) FILTER (WHERE tox.spam_score > 0.7)::INT AS spam_count,
  COUNT(*) FILTER (WHERE tox.scam_score > 0.5)::INT AS scam_count
FROM twitter_tweets t
LEFT JOIN tweet_sentiment s ON s.tweet_id = t.tweet_id
LEFT JOIN tweet_toxicity tox ON tox.tweet_id = t.tweet_id
GROUP BY t.handle;
CREATE UNIQUE INDEX IF NOT EXISTS mv_as_pk ON mv_author_sentiment(handle);

