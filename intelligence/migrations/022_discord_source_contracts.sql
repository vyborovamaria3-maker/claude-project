-- Additive source contract support for authorized Discord message evidence.
-- Existing X/TG/Solana rows and event clocks are unchanged. This only extends
-- accepted evidence/timeline domains; Discord producers remain disabled until
-- source Outbox delivery and operational authorization are ready.
ALTER TABLE entity_evidence
  DROP CONSTRAINT IF EXISTS entity_evidence_evidence_kind_check;
ALTER TABLE entity_evidence
  ADD CONSTRAINT entity_evidence_evidence_kind_check
  CHECK (evidence_kind IN ('x_tweet','tg_message','chain_tx','discord_message')) NOT VALID;
ALTER TABLE entity_evidence
  VALIDATE CONSTRAINT entity_evidence_evidence_kind_check;

ALTER TABLE timeline_events
  DROP CONSTRAINT IF EXISTS timeline_events_timeline_kind_check;
ALTER TABLE timeline_events
  ADD CONSTRAINT timeline_events_timeline_kind_check
  CHECK (timeline_kind IN (
    'tweet_published','tg_message_published','discord_message_published',
    'discord_message_edited','discord_message_deleted','chain_transaction','trade_executed',
    'signal_detected','signal_outcome'
  )) NOT VALID;
ALTER TABLE timeline_events
  VALIDATE CONSTRAINT timeline_events_timeline_kind_check;
