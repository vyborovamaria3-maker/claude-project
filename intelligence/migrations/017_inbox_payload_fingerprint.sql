-- Additive and safe for existing Intelligence databases.
-- Existing rows intentionally remain NULL until a bounded source-outbox
-- backfill proves the original normalized event payload.
ALTER TABLE intelligence_inbox ADD COLUMN IF NOT EXISTS payload_sha256 TEXT;

DO $fingerprint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'intelligence_inbox'::regclass
      AND conname = 'intelligence_inbox_payload_sha256_check'
  ) THEN
    ALTER TABLE intelligence_inbox
      ADD CONSTRAINT intelligence_inbox_payload_sha256_check
      CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END;
$fingerprint$;

ALTER TABLE intelligence_inbox VALIDATE CONSTRAINT intelligence_inbox_payload_sha256_check;

COMMENT ON COLUMN intelligence_inbox.payload_sha256 IS
  'Versioned replay fingerprint: canonical V1 RegistryEvent or full normalized V2 envelope; NULL means legacy/unfingerprinted.';
