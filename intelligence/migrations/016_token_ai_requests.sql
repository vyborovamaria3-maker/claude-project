-- Only explicit token requests write here. No raw social text or credentials.
CREATE TABLE IF NOT EXISTS token_ai_requests (
 request_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 canonical_token_id TEXT NOT NULL,
 input_sha256 TEXT NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
 model_id TEXT NOT NULL REFERENCES model_registry(model_id),
 report JSONB NOT NULL CHECK(jsonb_typeof(report)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_token_ai_request_cache ON token_ai_requests(input_sha256,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_ai_request_token ON token_ai_requests(canonical_token_id,created_at DESC);
