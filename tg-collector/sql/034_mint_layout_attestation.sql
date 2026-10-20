-- Earlier RPC checks accepted generic token accounts with mint-like bytes.
-- There is no on-chain account layout in the archive to verify old decisions
-- offline. Fail closed: retain raw evidence, but require a NEW strict RPC mint
-- check before counting previously accepted token identities as confirmed.
ALTER TABLE tg_tokens
  ADD COLUMN IF NOT EXISTS mint_layout_verified_at TIMESTAMPTZ;

UPDATE tg_token_candidates c SET resolution_status='unresolved',
  confidence=NULL,provider=NULL,checked_at=NULL
FROM tg_tokens t
WHERE c.chain_id=t.chain_id AND c.candidate_key=t.mint
  AND c.candidate_type='address' AND c.resolution_status='confirmed_token'
  AND t.chain_id='solana-mainnet' AND t.mint_layout_verified_at IS NULL;

UPDATE tg_ticker_registry r SET resolution_status='unresolved'
FROM tg_tokens t
WHERE r.chain_id=t.chain_id AND r.mint=t.mint
  AND t.chain_id='solana-mainnet' AND t.mint_layout_verified_at IS NULL
  AND r.resolution_status='confirmed';

UPDATE tg_token_mentions tm SET orphaned=TRUE
FROM tg_tokens t
WHERE tm.chain_id=t.chain_id AND tm.mint=t.mint
  AND t.chain_id='solana-mainnet' AND t.mint_layout_verified_at IS NULL
  AND tm.orphaned=FALSE;

DELETE FROM tg_token_first_mentions first
USING tg_tokens t
WHERE first.chain_id=t.chain_id AND first.mint=t.mint
  AND t.chain_id='solana-mainnet' AND t.mint_layout_verified_at IS NULL;

COMMENT ON COLUMN tg_tokens.mint_layout_verified_at IS
  'New structural RPC mint validation timestamp; NULL records must be rechecked after the pre-strict validator.';
