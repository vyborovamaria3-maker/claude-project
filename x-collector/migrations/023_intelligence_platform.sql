-- Additive, retention-independent intelligence storage. No inferred ownership.
CREATE TABLE ip_entities (
 id uuid PRIMARY KEY, type text NOT NULL CHECK(type IN ('PERSON','ACCOUNT','WALLET','TOKEN','PROJECT','COMPANY','ORGANIZATION','CONTRACT','TOPIC','LOCATION')),
 name text NOT NULL, external_id text NOT NULL, platform text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(type,platform,external_id)
);
CREATE INDEX ip_entities_type_external ON ip_entities(type,external_id);
CREATE INDEX ip_entities_name ON ip_entities(lower(name));
CREATE TABLE ip_raw_events (
 id uuid PRIMARY KEY, source text NOT NULL, event_type text NOT NULL, external_id text NOT NULL,
 payload jsonb NOT NULL, payload_hash text NOT NULL, collector_account text,
 collected_at timestamptz NOT NULL, normalized_at timestamptz, normalization_attempts int NOT NULL DEFAULT 0, normalization_error text,
 UNIQUE(source,event_type,external_id,payload_hash)
);
CREATE INDEX ip_raw_pending ON ip_raw_events(collected_at,id) WHERE normalized_at IS NULL;
CREATE INDEX ip_raw_external ON ip_raw_events(source,external_id);
CREATE TABLE ip_entity_relations (
 id uuid PRIMARY KEY, source_entity_id uuid NOT NULL REFERENCES ip_entities(id), target_entity_id uuid NOT NULL REFERENCES ip_entities(id),
 relation_type text NOT NULL CHECK(relation_type IN ('FOLLOW','FOLLOWED_BY','MENTION','REPLY','RETWEET','QUOTE','LIKE','CREATED','SHARED','DISCUSSED','SIMILAR_TOPIC','OWNS_WALLET','FUNDED','TRANSFERRED','DEPLOYED_TOKEN','INVESTED','SIMILAR_TO','SAME_CLUSTER','CONNECTED_BY_PATTERN')),
 weight double precision NOT NULL DEFAULT 1 CHECK(weight>=0), confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}', CHECK(valid_to IS NULL OR valid_to>=valid_from), CHECK(last_seen>=first_seen)
);
CREATE UNIQUE INDEX ip_relation_active ON ip_entity_relations(source_entity_id,target_entity_id,relation_type) WHERE valid_to IS NULL;
CREATE INDEX ip_relation_target ON ip_entity_relations(target_entity_id,relation_type);
CREATE INDEX ip_relation_time ON ip_entity_relations(valid_from,valid_to);
CREATE TABLE ip_relation_evidence (
 id uuid PRIMARY KEY, relation_id uuid NOT NULL REFERENCES ip_entity_relations(id), source_type text NOT NULL,
 source_id uuid NOT NULL REFERENCES ip_raw_events(id), confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(relation_id,source_type,source_id)
);
CREATE INDEX ip_evidence_source ON ip_relation_evidence(source_id);
CREATE TABLE ip_entity_profiles (
 entity_id uuid PRIMARY KEY REFERENCES ip_entities(id), influence_score double precision CHECK(influence_score BETWEEN 0 AND 1),
 authority_score double precision CHECK(authority_score BETWEEN 0 AND 1), trust_score double precision CHECK(trust_score BETWEEN 0 AND 1),
 risk_score double precision CHECK(risk_score BETWEEN 0 AND 1), activity_score double precision CHECK(activity_score BETWEEN 0 AND 1),
 metadata jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ip_tag_categories (id text PRIMARY KEY, name text NOT NULL, parent_id text REFERENCES ip_tag_categories(id));
CREATE TABLE ip_tags (id text PRIMARY KEY, name text NOT NULL, category_id text NOT NULL REFERENCES ip_tag_categories(id), parent_id text REFERENCES ip_tags(id));
CREATE TABLE ip_entity_tags (
 entity_id uuid NOT NULL REFERENCES ip_entities(id), tag_id text NOT NULL REFERENCES ip_tags(id),
 assigned_by text NOT NULL CHECK(assigned_by IN ('manual','AI','rule')), confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 source_id uuid NOT NULL REFERENCES ip_raw_events(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(entity_id,tag_id,assigned_by,source_id)
);
CREATE TABLE ip_entity_snapshots (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL REFERENCES ip_entities(id), raw_event_id uuid NOT NULL REFERENCES ip_raw_events(id),
 observed_at timestamptz NOT NULL, payload jsonb NOT NULL, UNIQUE(entity_id,raw_event_id)
);
CREATE INDEX ip_snapshot_history ON ip_entity_snapshots(entity_id,observed_at);
CREATE TABLE ip_behavior_events (
 id uuid PRIMARY KEY, actor_entity uuid NOT NULL REFERENCES ip_entities(id), target_entity uuid REFERENCES ip_entities(id),
 event_type text NOT NULL CHECK(event_type IN ('POST','LIKE','FOLLOW','RETWEET','QUOTE','REPLY','MENTION')),
 timestamp timestamptz, raw_event_id uuid NOT NULL REFERENCES ip_raw_events(id), external_id text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(actor_entity,event_type,external_id)
);
CREATE INDEX ip_behavior_time ON ip_behavior_events(timestamp);
CREATE INDEX ip_behavior_actor_time ON ip_behavior_events(actor_entity,timestamp);
CREATE TABLE ip_blockchain_transactions (
 hash text NOT NULL, chain text NOT NULL, from_entity uuid REFERENCES ip_entities(id), to_entity uuid REFERENCES ip_entities(id),
 token_entity uuid REFERENCES ip_entities(id), amount numeric NOT NULL CHECK(amount>=0), timestamp timestamptz,
 raw_event_id uuid NOT NULL REFERENCES ip_raw_events(id), metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(chain,hash)
);
CREATE TABLE ip_identity_links (
 id uuid PRIMARY KEY, entity_a uuid NOT NULL REFERENCES ip_entities(id), entity_b uuid NOT NULL REFERENCES ip_entities(id),
 relation text NOT NULL, confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 evidence uuid NOT NULL REFERENCES ip_raw_events(id), valid_from timestamptz NOT NULL, valid_to timestamptz,
 CHECK(entity_a<>entity_b), CHECK(valid_to IS NULL OR valid_to>=valid_from), UNIQUE(entity_a,entity_b,relation,evidence)
);
CREATE TABLE ip_graph_clusters (
 id uuid PRIMARY KEY, name text NOT NULL, score double precision CHECK(score BETWEEN 0 AND 1),
 metadata jsonb NOT NULL DEFAULT '{}', computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ip_cluster_members (cluster_id uuid NOT NULL REFERENCES ip_graph_clusters(id) ON DELETE CASCADE, entity_id uuid NOT NULL REFERENCES ip_entities(id), PRIMARY KEY(cluster_id,entity_id));
CREATE INDEX ip_clusters_entity ON ip_cluster_members(entity_id);
CREATE TABLE ip_entity_embeddings (
 entity_id uuid NOT NULL REFERENCES ip_entities(id), model text NOT NULL, vector double precision[] NOT NULL,
 dimensions int NOT NULL CHECK(dimensions>0), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(vector)=dimensions), PRIMARY KEY(entity_id,model)
);
CREATE INDEX ip_wallet_address ON ip_entities(external_id) WHERE type='WALLET';
INSERT INTO ip_tag_categories(id,name,parent_id) VALUES ('TECH','Technology',NULL),('ROLE','Role',NULL),('CONTENT','Content',NULL),('RISK','Risk',NULL),('BLOCKCHAIN','Blockchain','TECH');
INSERT INTO ip_tags(id,name,category_id,parent_id) VALUES
 ('crypto','Crypto','BLOCKCHAIN',NULL),('solana','Solana','BLOCKCHAIN','crypto'),('ethereum','Ethereum','BLOCKCHAIN','crypto'),
 ('trader','Trader','ROLE',NULL),('developer','Developer','ROLE',NULL),('vc','VC','ROLE',NULL),('influencer','Influencer','ROLE',NULL),('researcher','Researcher','ROLE',NULL),
 ('defi','DeFi','CONTENT',NULL),('nft','NFT','CONTENT',NULL),('gaming','Gaming','CONTENT',NULL),('memecoin','Memecoin','CONTENT',NULL),('memes','Memes','CONTENT',NULL),('politics','Politics','CONTENT',NULL),
 ('bot','Bot','RISK',NULL),('scam-risk','Scam risk','RISK',NULL),('fake-engagement','Fake engagement','RISK',NULL);
