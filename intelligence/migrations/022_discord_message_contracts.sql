-- Discord evidence and timeline support. Additive only: do not edit applied migrations.
-- The V2 source registry remains the authority for event kinds; this migration
-- only widens destination evidence/timeline enum-like CHECK constraints.

DO $discord_evidence_contract$
DECLARE definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'entity_evidence'::regclass
    AND conname = 'entity_evidence_evidence_kind_check';

  IF definition IS NULL THEN
    RAISE EXCEPTION 'entity_evidence_evidence_kind_check is missing; refusing implicit schema repair';
  ELSIF position('discord_message' IN definition) = 0 THEN
    IF position('x_tweet' IN definition) = 0
       OR position('tg_message' IN definition) = 0
       OR position('chain_tx' IN definition) = 0 THEN
      RAISE EXCEPTION 'entity_evidence_evidence_kind_check has an unexpected definition: %', definition;
    END IF;
    ALTER TABLE entity_evidence DROP CONSTRAINT entity_evidence_evidence_kind_check;
    ALTER TABLE entity_evidence
      ADD CONSTRAINT entity_evidence_evidence_kind_check
      CHECK (evidence_kind IN ('x_tweet','tg_message','chain_tx','discord_message')) NOT VALID;
  END IF;
END;
$discord_evidence_contract$;

ALTER TABLE entity_evidence
  VALIDATE CONSTRAINT entity_evidence_evidence_kind_check;

DO $discord_timeline_contract$
DECLARE definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'timeline_events'::regclass
    AND conname = 'timeline_events_timeline_kind_check';

  IF definition IS NULL THEN
    RAISE EXCEPTION 'timeline_events_timeline_kind_check is missing; refusing implicit schema repair';
  ELSIF position('discord_message_observed' IN definition) = 0
     OR position('discord_message_edited' IN definition) = 0 THEN
    IF position('tweet_published' IN definition) = 0
       OR position('tg_message_published' IN definition) = 0
       OR position('chain_transaction' IN definition) = 0
       OR position('signal_outcome' IN definition) = 0 THEN
      RAISE EXCEPTION 'timeline_events_timeline_kind_check has an unexpected definition: %', definition;
    END IF;
    ALTER TABLE timeline_events DROP CONSTRAINT timeline_events_timeline_kind_check;
    ALTER TABLE timeline_events
      ADD CONSTRAINT timeline_events_timeline_kind_check
      CHECK (timeline_kind IN (
        'tweet_published','tg_message_published','chain_transaction',
        'discord_message_observed','discord_message_edited',
        'trade_executed','signal_detected','signal_outcome'
      )) NOT VALID;
  END IF;
END;
$discord_timeline_contract$;

ALTER TABLE timeline_events
  VALIDATE CONSTRAINT timeline_events_timeline_kind_check;

COMMENT ON CONSTRAINT entity_evidence_evidence_kind_check ON entity_evidence IS
  'Accepted source evidence kinds include Discord message IDs; payload text is not stored here.';
COMMENT ON CONSTRAINT timeline_events_timeline_kind_check ON timeline_events IS
  'Discord observed/edited timeline entries are metadata-only; deleted messages are tombstones, not timeline bodies.';
