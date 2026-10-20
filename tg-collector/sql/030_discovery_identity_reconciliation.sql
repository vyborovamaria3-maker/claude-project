-- Old discovery linked source_id through mutable usernames. Keep all public
-- evidence but remove associations that cannot be verified by immutable peer.
UPDATE tg_discovered_sources d
SET source_id=NULL, connected_at=NULL
WHERE d.source_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tg_sources s WHERE s.id=d.source_id AND s.peer_id=d.peer_id
  );

-- An existing connected_at with NULL source_id can be an intentional removal
-- tombstone (ON DELETE SET NULL). Preserve it; do not resurrect deleted peers.

UPDATE tg_discovery_mentions dm
SET source_id=NULL
WHERE dm.source_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tg_sources s WHERE s.id=dm.source_id AND s.peer_id=dm.peer_id
  );

-- No messages, candidate peer IDs, or discovery evidence are deleted.
