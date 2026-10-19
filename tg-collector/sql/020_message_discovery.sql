ALTER TABLE tg_discovery_settings
 ADD COLUMN message_search_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN message_terms text[] NOT NULL DEFAULT ARRAY['PNUT','Peanut the Squirrel','2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump'] CHECK(cardinality(message_terms) BETWEEN 1 AND 30);
CREATE TABLE tg_discovery_mentions (
 peer_id text NOT NULL,message_id bigint NOT NULL,username text NOT NULL,title text NOT NULL,
 text text NOT NULL,posted_at timestamptz,matched_terms text[] NOT NULL,
 source_id bigint REFERENCES tg_sources(id) ON DELETE SET NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(peer_id,message_id)
);
CREATE INDEX tg_discovery_mentions_recent_idx ON tg_discovery_mentions(first_seen_at DESC);
CREATE TABLE tg_message_search_cursors (
 query text PRIMARY KEY,offset_rate integer NOT NULL DEFAULT 0,offset_id integer NOT NULL DEFAULT 0,
 channel_id text,access_hash text,reset_at timestamptz NOT NULL DEFAULT now()+interval '6 hours',
 reported_count integer,last_error_code text,updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tg_sources ADD COLUMN full_history boolean NOT NULL DEFAULT false,
 ADD COLUMN history_complete boolean NOT NULL DEFAULT false;
ALTER TABLE tg_messages ADD COLUMN reactions jsonb NOT NULL DEFAULT '[]';
CREATE TABLE tg_source_discussions (
 channel_source_id bigint PRIMARY KEY REFERENCES tg_sources(id) ON DELETE CASCADE,
 discussion_source_id bigint REFERENCES tg_sources(id) ON DELETE SET NULL,
 peer_id text,status text NOT NULL,checked_at timestamptz NOT NULL DEFAULT now()
);
