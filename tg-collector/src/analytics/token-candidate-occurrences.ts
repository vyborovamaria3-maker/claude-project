import type {PoolClient} from "pg";
import {SOLANA_CHAIN_ID} from "./token-intelligence.js";
import {ANALYSIS_VERSION} from "./extract.js";

/** RPC attribution must never revive a soft-deleted Telegram post. */
export async function activeMintOccurrences(
  tx:PoolClient,mint:string,chainId=SOLANA_CHAIN_ID,version=ANALYSIS_VERSION,
) {
  return tx.query<{
    source_id:string;message_id:string;message_date:Date|null;tickers:string[];text:string;
  }>(
    "SELECT c.source_id::text,c.message_id::text,m.posted_at AS message_date,m.text," +
    "COALESCE(array_agg(DISTINCT t.ticker) FILTER (WHERE t.ticker IS NOT NULL),'{}') AS tickers " +
    "FROM tg_token_candidates c JOIN tg_messages m USING(source_id,message_id) " +
    "LEFT JOIN tg_ticker_mentions t ON t.source_id=c.source_id AND t.message_id=c.message_id " +
    "AND t.chain_id=c.chain_id AND t.analysis_version=$3 " +
    "WHERE c.chain_id=$1 AND c.candidate_type='address' AND c.candidate_key=$2 " +
    "AND c.analysis_version=$3 AND m.deleted_at IS NULL GROUP BY c.source_id,c.message_id,m.posted_at,m.text",
    [chainId,mint,version],
  );
}
