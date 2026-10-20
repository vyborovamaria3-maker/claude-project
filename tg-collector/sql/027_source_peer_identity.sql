-- Enforce a single canonical record per Telegram channel.
-- Do not silently coalesce potentially contaminated historical message/evidence rows.
DO $check$
DECLARE duplicate_peer TEXT;
BEGIN
  SELECT peer_id INTO duplicate_peer FROM tg_sources
  WHERE peer_id IS NOT NULL GROUP BY peer_id HAVING count(*) > 1 LIMIT 1;
  IF duplicate_peer IS NOT NULL THEN
    RAISE EXCEPTION 'TG_DUPLICATE_PEER_REQUIRES_REVIEW: duplicate tg_sources peer_id %, manually reconcile before migration', duplicate_peer;
  END IF;
END
$check$;

CREATE UNIQUE INDEX IF NOT EXISTS tg_sources_peer_identity_unique
ON tg_sources(peer_id) WHERE peer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tg_sources_current_username_idx
ON tg_sources(current_username) WHERE current_username IS NOT NULL;

COMMENT ON INDEX tg_sources_peer_identity_unique IS
  'A verified immutable Telegram peer ID can belong to exactly one source; old usernames can be reused.';
