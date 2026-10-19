-- Opt-in bounded public source discovery, using the collector's existing session.
CREATE TABLE tg_discovery_settings (
 id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
 keywords text[] NOT NULL DEFAULT ARRAY['memecoin','crypto','solana','pumpfun','мемкоины','криптовалюта'],
 interval_minutes integer NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 15 AND 1440),
 results_per_query integer NOT NULL DEFAULT 10 CHECK(results_per_query BETWEEN 1 AND 50),
 queries_per_cycle integer NOT NULL DEFAULT 1 CHECK(queries_per_cycle BETWEEN 1 AND 10),
 max_queries_per_day integer NOT NULL DEFAULT 24 CHECK(max_queries_per_day BETWEEN 1 AND 200),
 max_new_per_day integer NOT NULL DEFAULT 3 CHECK(max_new_per_day BETWEEN 1 AND 100),
 max_sources integer NOT NULL DEFAULT 30 CHECK(max_sources BETWEEN 1 AND 1000),
 keyword_cursor integer NOT NULL DEFAULT 0 CHECK(keyword_cursor>=0),
 revision integer NOT NULL DEFAULT 1,
 next_run_at timestamptz NOT NULL DEFAULT now(), last_run_at timestamptz,
 last_completed_at timestamptz, last_error_code text,
 CHECK(cardinality(keywords) BETWEEN 1 AND 30)
);
INSERT INTO tg_discovery_settings(id) VALUES(1);
CREATE TABLE tg_discovery_daily (
 day date PRIMARY KEY, queries integer NOT NULL DEFAULT 0,
 added integer NOT NULL DEFAULT 0, CHECK(queries>=0 AND added>=0)
);
CREATE TABLE tg_discovered_sources (
 peer_id text PRIMARY KEY, username text NOT NULL, title text NOT NULL,
 keyword text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 source_id bigint REFERENCES tg_sources(id) ON DELETE SET NULL,
 connected_at timestamptz
);
CREATE INDEX tg_discovered_sources_seen_idx ON tg_discovered_sources(last_seen_at DESC);
