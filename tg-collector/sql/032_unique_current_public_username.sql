-- A public username belongs to one Telegram channel at a time. Older
-- discovery/worker snapshots can contain collisions after a reassignment.
-- Do not guess which historical peer currently owns a conflicting handle:
-- clear all ambiguous cached handles until the worker verifies them anew.
UPDATE tg_sources s SET current_username=NULL
WHERE s.current_username IS NOT NULL
  AND EXISTS(SELECT 1 FROM tg_sources another
    WHERE another.id<>s.id AND another.current_username=s.current_username);

-- Runtime resolution updates the current owner and evicts older stale aliases.
CREATE UNIQUE INDEX IF NOT EXISTS tg_sources_current_username_unique
ON tg_sources(current_username) WHERE current_username IS NOT NULL;
