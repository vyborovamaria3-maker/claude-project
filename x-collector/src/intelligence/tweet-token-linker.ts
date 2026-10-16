import { addresses, validMint } from "../../lib/archive/model";
import { q, tx } from "../../lib/trade/pg";

export const TWEET_TOKEN_LINKER_VERSION = "v1";

export interface TweetTokenAddressMatch {
  mint: string;
  matchMethod: "mint_literal";
  matchLevel: "exact";
  confidence: 1;
  evidence: { kind: "mint_literal"; address: string; position: number };
}

interface TweetRow {
  tweet_id: string;
  handle: string;
  text: string | null;
}

export interface TweetTokenLinkBatchResult {
  scanned: number;
  linksWritten: number;
  matchedTweets: number;
  registryMints: number;
  registryEmpty: boolean;
}

/** Only exact address mentions that match a known token registry entry are linked. */
export function matchKnownTokenAddresses(text: string | null, knownMints: ReadonlySet<string>): TweetTokenAddressMatch[] {
  if (!text || knownMints.size === 0) return [];
  return addresses(text)
    .filter(mint => knownMints.has(mint))
    .map(mint => ({
      mint,
      matchMethod: "mint_literal" as const,
      matchLevel: "exact" as const,
      confidence: 1 as const,
      evidence: { kind: "mint_literal" as const, address: mint, position: text.indexOf(mint) },
    }));
}

export async function loadKnownTokenMints(): Promise<Set<string>> {
  const rows = await q<{ mint: string }>(
    "SELECT mint FROM archive_tokens UNION SELECT external_id AS mint FROM ip_entities WHERE type = 'TOKEN' AND (lower(platform) LIKE '%solana%' OR lower(COALESCE(metadata->>'chain', '')) = 'solana')",
  );
  return new Set(rows.map(row => row.mint).filter(validMint));
}

/**
 * Processes one locked batch outside Collector. A task-context link is upgraded
 * only when the tweet text contains the same address and that address exists in
 * archive_tokens or the Solana token entity registry.
 */
export async function linkTweetsToKnownTokens(limit = 250, registry?: ReadonlySet<string>): Promise<TweetTokenLinkBatchResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("linker limit must be an integer between 1 and 1000");
  const knownMints = registry ?? await loadKnownTokenMints();
  if (knownMints.size === 0) return { scanned: 0, linksWritten: 0, matchedTweets: 0, registryMints: 0, registryEmpty: true };

  return tx(async client => {
    const pending = await client.query<TweetRow>(
      "SELECT t.tweet_id, t.handle, t.text FROM twitter_tweets t " +
      "WHERE NOT EXISTS (SELECT 1 FROM tweet_token_linker_state s WHERE s.tweet_id = t.tweet_id AND s.linker_version = $1 AND s.status = 'done') " +
      "ORDER BY t.first_seen_at ASC NULLS LAST, t.tweet_id ASC LIMIT $2 FOR UPDATE OF t SKIP LOCKED",
      [TWEET_TOKEN_LINKER_VERSION, limit],
    );
    let linksWritten = 0;
    let matchedTweets = 0;
    for (const tweet of pending.rows) {
      const matches = matchKnownTokenAddresses(tweet.text, knownMints);
      if (matches.length) matchedTweets++;
      for (const match of matches) {
        const result = await client.query(
          "INSERT INTO tweet_token_links (tweet_id, mint, handle, linked_at, match_method, match_level, confidence, evidence, linker_version) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
          "ON CONFLICT (tweet_id, mint) DO UPDATE SET " +
          "match_method = CASE WHEN EXCLUDED.confidence >= tweet_token_links.confidence THEN EXCLUDED.match_method ELSE tweet_token_links.match_method END, " +
          "match_level = CASE WHEN EXCLUDED.confidence >= tweet_token_links.confidence THEN EXCLUDED.match_level ELSE tweet_token_links.match_level END, " +
          "confidence = GREATEST(tweet_token_links.confidence, EXCLUDED.confidence), " +
          "evidence = CASE WHEN EXCLUDED.confidence >= tweet_token_links.confidence THEN EXCLUDED.evidence ELSE tweet_token_links.evidence END, " +
          "linker_version = CASE WHEN EXCLUDED.confidence >= tweet_token_links.confidence THEN EXCLUDED.linker_version ELSE tweet_token_links.linker_version END",
          [tweet.tweet_id, match.mint, tweet.handle, Date.now(), match.matchMethod, match.matchLevel, match.confidence, match.evidence, TWEET_TOKEN_LINKER_VERSION],
        );
        linksWritten += result.rowCount ?? 0;
      }
      await client.query(
        "INSERT INTO tweet_token_linker_state (tweet_id, linker_version, status, processed_at, error) VALUES ($1,$2,'done',now(),NULL) " +
        "ON CONFLICT (tweet_id, linker_version) DO UPDATE SET status = 'done', processed_at = now(), error = NULL",
        [tweet.tweet_id, TWEET_TOKEN_LINKER_VERSION],
      );
    }
    return { scanned: pending.rows.length, linksWritten, matchedTweets, registryMints: knownMints.size, registryEmpty: false };
  });
}

/** Reprocess historical tweets after an intentional linker/registry refresh; existing links are never deleted. */
export async function resetTweetTokenLinkerState(): Promise<number> {
  return tx(async client => {
    const result = await client.query("DELETE FROM tweet_token_linker_state WHERE linker_version = $1", [TWEET_TOKEN_LINKER_VERSION]);
    return result.rowCount ?? 0;
  });
}