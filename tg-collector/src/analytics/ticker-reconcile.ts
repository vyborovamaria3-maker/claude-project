import type {PoolClient} from "pg";
import {ANALYSIS_VERSION} from "./extract.js";
import {SOLANA_CHAIN_ID} from "./token-intelligence.js";

/** Retract ticker-only mappings once a cashtag has more than one mint.
 * Explicit on-message mint addresses still attest to their own identity.
 * Returns affected historical days for atomic metrics reconciliation. */
export async function retractAmbiguousTickerMentions(
  tx:PoolClient, chainId=SOLANA_CHAIN_ID,analysisVersion=ANALYSIS_VERSION,
) {
  return tx.query<{
    source_id:string; day:string|null; mint:string;
      }>(`UPDATE tg_token_mentions tm SET orphaned=TRUE
    FROM tg_messages m
    WHERE m.source_id=tm.source_id AND m.message_id=tm.message_id
      AND tm.chain_id=$1 AND tm.analysis_version=$2
      AND tm.mention_type='ticker' AND tm.orphaned=FALSE
      AND NOT EXISTS (SELECT 1 FROM tg_token_candidates addr
        WHERE addr.source_id=tm.source_id AND addr.message_id=tm.message_id
          AND addr.chain_id=tm.chain_id AND addr.analysis_version=tm.analysis_version
          AND addr.candidate_type='address' AND addr.candidate_key=tm.mint)
      AND EXISTS (SELECT 1 FROM tg_ticker_mentions tick
        WHERE tick.source_id=tm.source_id AND tick.message_id=tm.message_id
          AND tick.chain_id=tm.chain_id AND tick.analysis_version=tm.analysis_version
          AND (SELECT count(DISTINCT reg.mint) FROM tg_ticker_registry reg
        WHERE reg.chain_id=tick.chain_id AND reg.ticker=tick.ticker
        AND reg.resolution_status='confirmed' AND reg.mint IS NOT NULL)>1)
      AND NOT EXISTS (SELECT 1 FROM tg_ticker_mentions tick
        JOIN tg_ticker_registry reg ON reg.ticker=tick.ticker
          AND reg.chain_id=tick.chain_id AND reg.mint=tm.mint
          AND reg.resolution_status='confirmed'
        WHERE tick.source_id=tm.source_id AND tick.message_id=tm.message_id
          AND tick.chain_id=tm.chain_id AND tick.analysis_version=tm.analysis_version
          AND (SELECT count(DISTINCT other.mint) FROM tg_ticker_registry other
        WHERE other.chain_id=tick.chain_id AND other.ticker=tick.ticker
          AND other.resolution_status='confirmed' AND other.mint IS NOT NULL)=1)
    RETURNING tm.source_id::text,m.posted_at::date::text AS day,tm.mint`,
    [chainId, analysisVersion]);

}
