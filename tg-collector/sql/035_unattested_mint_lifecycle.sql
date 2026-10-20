-- The original soft-delete lifecycle trigger restores every old token
-- mention when a message is undeleted. Keep pre-strict mint candidates inactive
-- even if a Telegram message is subsequently restored.
CREATE OR REPLACE FUNCTION tg_enforce_mint_attestation_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN RETURN NEW; END IF;
  UPDATE tg_token_mentions tm SET orphaned=TRUE
  FROM tg_tokens t
  WHERE tm.source_id=NEW.source_id AND tm.message_id=NEW.message_id
    AND tm.chain_id=t.chain_id AND tm.mint=t.mint
    AND t.chain_id='solana-mainnet'
    AND t.mint_layout_verified_at IS NULL AND tm.orphaned=FALSE;

  DELETE FROM tg_token_first_mentions f USING tg_tokens t
  WHERE f.chain_id=t.chain_id AND f.mint=t.mint
    AND t.chain_id='solana-mainnet' AND t.mint_layout_verified_at IS NULL
    AND EXISTS (SELECT 1 FROM tg_token_mentions tm
      WHERE tm.source_id=NEW.source_id AND tm.message_id=NEW.message_id
        AND tm.chain_id=f.chain_id AND tm.mint=f.mint);
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS tg_zz_mint_attestation_lifecycle_trg ON tg_messages;
CREATE TRIGGER tg_zz_mint_attestation_lifecycle_trg
  AFTER UPDATE OF deleted_at ON tg_messages
  FOR EACH ROW EXECUTE FUNCTION tg_enforce_mint_attestation_lifecycle();
