ALTER TABLE tg_discovery_settings
 ADD COLUMN pump_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN pump_min_ath_usd integer NOT NULL DEFAULT 100000 CHECK(pump_min_ath_usd BETWEEN 1000 AND 1000000000),
 ADD COLUMN pump_max_tokens integer NOT NULL DEFAULT 3 CHECK(pump_max_tokens BETWEEN 1 AND 10),
 ADD COLUMN pump_queries text[] NOT NULL DEFAULT '{}' CHECK(cardinality(pump_queries)<=10),
 ADD COLUMN pump_results jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN pump_error_code text;
