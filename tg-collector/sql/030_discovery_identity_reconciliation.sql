-- Old discovery linked source_id through mutable usernames. Keep all public
-- evidence but remove associations that cannot be verified by immutable peer.
UPDATE tg_discovered_sources d
SET source_id=NULL, connected_at=NULL
WHERE d.source_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tg_sources s WHERE s.id=d.source_id AND s.peer_id=d.peer_id
  );

-- An old "connected" timestamp without a verified tracked source must not
-- suppress discovery of the real channel behind a recycled username.
UPDATE tg_discovered_sources
SET connected_at=NULL
WHERE source_id IS NULL AND connected_at IS NOT NULL;

UPDATE tg_discovery_mentions dm
SET source_id=NULL
WHERE dm.source_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tg_sources s WHERE s.id=dm.source_id AND s.peer_id=dm.peer_id
  );

-- No messages, candidate peer IDs, or discovery evidence are deleted.
