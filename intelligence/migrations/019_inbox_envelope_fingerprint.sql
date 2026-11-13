-- Additive V1/V2 replay compatibility.
-- payload_sha256 remains the stable normalized RegistryEvent fingerprint.
-- envelope_sha256 stores the complete canonical V2 envelope hash only.
ALTER TABLE intelligence_inbox
  ADD COLUMN IF NOT EXISTS envelope_sha256 TEXT;

DO $envelope_fingerprint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'intelligence_inbox'::regclass
      AND conname = 'intelligence_inbox_envelope_sha256_check'
  ) THEN
    ALTER TABLE intelligence_inbox
      ADD CONSTRAINT intelligence_inbox_envelope_sha256_check
      CHECK (envelope_sha256 IS NULL OR envelope_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END;
$envelope_fingerprint$;

-- IF NOT EXISTS above is intentionally name-based. Refuse a same-named but
-- semantically different constraint instead of treating it as migration 019.
DO $envelope_fingerprint_definition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'intelligence_inbox'::regclass
      AND conname = 'intelligence_inbox_envelope_sha256_check'
      AND contype = 'c'
      AND position('envelope_sha256' in pg_get_constraintdef(oid)) > 0
      AND position('^[0-9a-f]{64}$' in pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'intelligence_inbox_envelope_sha256_check has an unexpected definition';
  END IF;
END;
$envelope_fingerprint_definition$;

ALTER TABLE intelligence_inbox
  VALIDATE CONSTRAINT intelligence_inbox_envelope_sha256_check;

COMMENT ON COLUMN intelligence_inbox.payload_sha256 IS
  'Stable normalized RegistryEvent fingerprint shared by V1 and V2 deliveries.';
COMMENT ON COLUMN intelligence_inbox.envelope_sha256 IS
  'Full canonical V2 envelope SHA-256. NULL means the event has only been observed as V1 or has not been safely promoted.';
