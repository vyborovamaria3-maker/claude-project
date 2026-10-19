ALTER TABLE tg_discovery_settings
 ADD COLUMN external_search_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN external_sources text[] NOT NULL DEFAULT ARRAY['AscendEXEnglish','AscendEXAnnoucement','coinkolik','cg_listingalert','Dex_Trade','OKX_Ukraine','cryptonarratives1','indodax','Coin_Signals'] CHECK(cardinality(external_sources) BETWEEN 1 AND 50),
 ADD COLUMN external_pages_per_cycle integer NOT NULL DEFAULT 1 CHECK(external_pages_per_cycle BETWEEN 1 AND 3),
 ADD COLUMN external_max_pages_per_day integer NOT NULL DEFAULT 24 CHECK(external_max_pages_per_day BETWEEN 1 AND 48),
 ADD COLUMN external_last_run_at timestamptz,ADD COLUMN external_error_code text;
CREATE TABLE tg_external_candidates (
 username text PRIMARY KEY,origin text NOT NULL,priority integer NOT NULL DEFAULT 0,
 term_cursor integer NOT NULL DEFAULT 0,first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_checked_at timestamptz,status text NOT NULL DEFAULT 'pending'
);
CREATE TABLE tg_external_search_cursors (
 username text NOT NULL,query text NOT NULL,before_id integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(username,query)
);
CREATE TABLE tg_external_daily(day date PRIMARY KEY,pages integer NOT NULL DEFAULT 0,rpc_reserved integer NOT NULL DEFAULT 0);
CREATE TABLE tg_external_verified_posts (
 peer_id text NOT NULL,message_id bigint NOT NULL,provider text NOT NULL,origin text NOT NULL,
 reference_url text NOT NULL,verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(peer_id,message_id,provider),
 FOREIGN KEY(peer_id,message_id)REFERENCES tg_discovery_mentions(peer_id,message_id)ON DELETE CASCADE
);
