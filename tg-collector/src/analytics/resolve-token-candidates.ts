import "dotenv/config";
import { createHash } from "node:crypto";
import { emitVerifiedTgTokenLinkOutbox, telegramVerifiedTokenLinksEnabled } from "../persistence/outbox.js";
import { pool, migrate } from "../db.js";
import { ANALYSIS_VERSION } from "./extract.js";
import { detectPropagationPatterns, refreshChannelScores, refreshTokenChannelMetrics, SOLANA_CHAIN_ID } from "./token-intelligence.js";
import { syncTokenNarratives } from "./narratives.js";
import { readMintAccount } from "./solana-mint-rpc.js";
import {retractAmbiguousTickerMentions} from "./ticker-reconcile.js";
import {activeMintOccurrences} from "./token-candidate-occurrences.js";

async function recomputeFirstMention(tx: import("pg").PoolClient, mint: string): Promise<void> {
  await tx.query(`DELETE FROM tg_token_first_mentions f
    WHERE f.chain_id=$1 AND f.mint=$2
      AND NOT EXISTS (SELECT 1 FROM tg_token_mentions tm
        JOIN tg_messages m USING(source_id,message_id)
        WHERE tm.chain_id=f.chain_id AND tm.mint=f.mint
          AND tm.analysis_version=$3 AND tm.orphaned=FALSE AND m.deleted_at IS NULL)`,
    [SOLANA_CHAIN_ID,mint,ANALYSIS_VERSION]);
  await tx.query(
    "WITH first_row AS (" +
    "SELECT tm.chain_id,tm.mint,tm.source_id,tm.message_id,tm.message_date,tm.observed_at," +
    "tm.analysis_version,s.history_partial FROM tg_token_mentions tm " +
    "JOIN tg_messages m USING(source_id,message_id) JOIN tg_sources s ON s.id=tm.source_id " +
    "WHERE tm.chain_id=$1 AND tm.mint=$2 AND tm.analysis_version=$3 AND tm.orphaned=FALSE AND m.deleted_at IS NULL " +
    "ORDER BY tm.message_date ASC NULLS LAST,tm.observed_at,tm.source_id,tm.message_id LIMIT 1) " +
    "INSERT INTO tg_token_first_mentions(chain_id,mint,source_id,message_id,message_date,observed_at," +
    "coverage_status,analysis_version,calculated_at) " +
    "SELECT chain_id,mint,source_id,message_id,message_date,observed_at," +
    "CASE WHEN history_partial THEN 'partial_source_history' ELSE 'collected_source_history' END," +
    "analysis_version,now() FROM first_row " +
    "ON CONFLICT(chain_id,mint) DO UPDATE SET source_id=EXCLUDED.source_id,message_id=EXCLUDED.message_id," +
    "message_date=EXCLUDED.message_date,observed_at=EXCLUDED.observed_at,coverage_status=EXCLUDED.coverage_status," +
    "analysis_version=EXCLUDED.analysis_version,calculated_at=now()",
    [SOLANA_CHAIN_ID, mint, ANALYSIS_VERSION],
  );
}

async function main(): Promise<void> {
  await migrate();
  const rpcUrl = process.env.ALCHEMY_SOLANA_RPC_URL?.trim();
  if (!rpcUrl || !/^https:\/\//i.test(rpcUrl)) {
    throw new Error("Set ALCHEMY_SOLANA_RPC_URL to the Alchemy Solana HTTPS RPC endpoint. Never commit this URL or its API key.");
  }
  const limitRaw = process.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  const limit = limitRaw === undefined ? 100 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be an integer from 1 to 1000");

  const candidates = await pool.query<{ mint: string }>(
    "SELECT DISTINCT c.candidate_key AS mint FROM tg_token_candidates c " +
    "JOIN tg_messages m ON m.source_id=c.source_id AND m.message_id=c.message_id " +
    "WHERE c.chain_id=$1 AND c.candidate_type='address' AND c.analysis_version=$3 " +
    "AND m.deleted_at IS NULL AND c.resolution_status IN ('unresolved','ambiguous') " +
    "AND (c.checked_at IS NULL OR c.checked_at < now() - interval '24 hours') " +
    "ORDER BY c.candidate_key LIMIT $2",
    [SOLANA_CHAIN_ID, limit, ANALYSIS_VERSION],
  );
  let verified = 0;
  let rejected = 0;
  let deferred = 0;
  const affected = new Map<string, Set<string>>();

  for (const candidate of candidates.rows) {
    let mintInfo: { decimals: number; owner: string } | null;
    try {
      mintInfo = await readMintAccount(rpcUrl, candidate.mint);
    } catch {
      deferred++;
      // Never print raw RPC/provider errors: they may include private URLs or keys.
      console.warn("Mint verification deferred: provider_unavailable_or_invalid");
      continue;
    }

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      if (!mintInfo) {
        await tx.query(
          // A not-yet-created mint may become valid later. Do not permanently
          // label addresses as not_token; back off retry by 24 hours.
          "UPDATE tg_token_candidates c SET resolution_status='ambiguous',confidence=NULL," +
          "provider='alchemy-solana-rpc',checked_at=now() FROM tg_messages m " +
          "WHERE m.source_id=c.source_id AND m.message_id=c.message_id AND m.deleted_at IS NULL " +
          "AND c.chain_id=$1 AND c.candidate_type='address' " +
          "AND c.candidate_key=$2 AND c.analysis_version=$3 " +
          "AND resolution_status IN ('unresolved','ambiguous')",
          [SOLANA_CHAIN_ID, candidate.mint, ANALYSIS_VERSION],
        );
        rejected++;
        await tx.query("COMMIT");
        continue;
      }

      await tx.query(
        "INSERT INTO tg_tokens(chain_id,mint,decimals,token_program,metadata_status,metadata_provider,metadata_updated_at,mint_layout_verified_at) " +
        "VALUES($1,$2,$3,$4,'partial','alchemy-solana-rpc',now(),now()) " +
        "ON CONFLICT(chain_id,mint) DO UPDATE SET decimals=EXCLUDED.decimals,token_program=EXCLUDED.token_program," +
        "metadata_status=CASE WHEN tg_tokens.metadata_status='verified' THEN 'verified' ELSE 'partial' END," +
        "metadata_provider=EXCLUDED.metadata_provider,metadata_updated_at=now(),mint_layout_verified_at=now()",
        [SOLANA_CHAIN_ID, candidate.mint, mintInfo.decimals, mintInfo.owner],
      );
      await tx.query(
        "UPDATE tg_token_candidates c SET resolution_status='confirmed_token',confidence=1," +
        "provider='alchemy-solana-rpc',checked_at=now() FROM tg_messages m " +
        "WHERE m.source_id=c.source_id AND m.message_id=c.message_id AND m.deleted_at IS NULL " +
        "AND c.chain_id=$1 AND c.candidate_type='address' " +
        "AND c.candidate_key=$2 AND c.analysis_version=$3 " +
        "AND resolution_status IN ('unresolved','ambiguous','confirmed_token')",
        [SOLANA_CHAIN_ID, candidate.mint, ANALYSIS_VERSION],
      );

      const occurrences = await activeMintOccurrences(tx,candidate.mint);
      for (const occurrence of occurrences.rows) {
        // Lock the exact source evidence before confirming mint links.
        // Otherwise an edit/delete racing the RPC resolver could publish a
        // verified event with a NEW timestamp for an OLD source revision.
        const locked=await tx.query<{text:string|null;deleted_at:Date|null}>(
          "SELECT text,deleted_at FROM tg_messages WHERE source_id=$1 AND message_id=$2 FOR UPDATE",
          [occurrence.source_id,occurrence.message_id],
        );
        if(!locked.rows[0] || locked.rows[0].deleted_at!==null ||
           locked.rows[0].text!==occurrence.text)continue;
        await tx.query(
          "INSERT INTO tg_token_mentions(source_id,message_id,chain_id,mint,mention_type,resolution_status," +
          "confidence,message_date,analysis_version,extractor_name,orphaned) " +
          "VALUES($1,$2,$3,$4,'mint','confirmed',1,$5,$6,'telegram-text',FALSE) " +
          "ON CONFLICT(source_id,message_id,chain_id,mint,mention_type,analysis_version) " +
          "DO UPDATE SET orphaned=FALSE,observed_at=LEAST(tg_token_mentions.observed_at,now())",
          [occurrence.source_id, occurrence.message_id, SOLANA_CHAIN_ID, candidate.mint,
            occurrence.message_date, ANALYSIS_VERSION],
        );

        // Bind a ticker only when exactly one explicit cashtag occurs in the same message.
        if (occurrence.tickers.length === 1) {
          const ticker = occurrence.tickers[0];
          await tx.query(
            "INSERT INTO tg_ticker_registry(ticker,chain_id,mint,resolution_status,confidence,evidence_count) " +
            "VALUES($1,$2,$3,'confirmed',0.98,1) " +
            "ON CONFLICT(ticker,chain_id,mint) WHERE mint IS NOT NULL DO UPDATE SET " +
            "resolution_status='confirmed',confidence=greatest(tg_ticker_registry.confidence,EXCLUDED.confidence)," +
            "evidence_count=tg_ticker_registry.evidence_count+1,last_seen_at=now()",
            [ticker, SOLANA_CHAIN_ID, candidate.mint],
          );
          await tx.query(
            "INSERT INTO tg_token_mentions(source_id,message_id,chain_id,mint,mention_type,resolution_status," +
            "confidence,message_date,analysis_version,extractor_name,orphaned) " +
            "VALUES($1,$2,$3,$4,'ticker','confirmed',0.98,$5,$6,'telegram-text',FALSE) " +
            "ON CONFLICT(source_id,message_id,chain_id,mint,mention_type,analysis_version) " +
            "DO UPDATE SET orphaned=FALSE",
            [occurrence.source_id, occurrence.message_id, SOLANA_CHAIN_ID, candidate.mint,
              occurrence.message_date, ANALYSIS_VERSION],
          );
        }
        await tx.query(
          "UPDATE tg_token_mentions tm SET copy_cluster_id=fp.cluster_id " +
          "FROM tg_message_fingerprints fp WHERE tm.source_id=$1 AND tm.message_id=$2 " +
          "AND tm.chain_id=$3 AND tm.mint=$4 AND tm.analysis_version=$5 " +
          "AND fp.source_id=tm.source_id AND fp.message_id=tm.message_id AND fp.analysis_version=$5",
          [occurrence.source_id, occurrence.message_id, SOLANA_CHAIN_ID, candidate.mint, ANALYSIS_VERSION],
        );
        await syncTokenNarratives(tx, occurrence.source_id, occurrence.message_id,
          SOLANA_CHAIN_ID, candidate.mint, occurrence.text);

        // The existing RPC call above actually verified an initialized SPL
        // Mint account. Emit historical mint evidence in the SAME transaction.
        // Missing immutable peer identity and stale/nonliteral text fail closed.
        if (telegramVerifiedTokenLinksEnabled() && occurrence.peer_id &&
            typeof occurrence.text==="string" &&
            new RegExp("(?<![1-9A-HJ-NP-Za-km-z])"+candidate.mint+"(?![1-9A-HJ-NP-Za-km-z])").test(occurrence.text)) {
          const revision=createHash("sha256").update(JSON.stringify([
            occurrence.text,occurrence.message_date?.toISOString()??null,
            occurrence.edited_at?.toISOString()??null,
          ])).digest("hex");
          await emitVerifiedTgTokenLinkOutbox(tx,{
            peerId:occurrence.peer_id,messageId:occurrence.message_id,
            text:occurrence.text,mint:candidate.mint,tokenProgram:mintInfo.owner,
            provider:"alchemy-solana-rpc",sourceRevisionSha256:revision,
            observedAt:new Date(),postedAt:occurrence.message_date,
          });
        }

        const day = occurrence.message_date?.toISOString().slice(0, 10);
        if (day) {
          const days = affected.get(occurrence.source_id) ?? new Set<string>();
          days.add(day);
          affected.set(occurrence.source_id, days);
        }
      }
      // A ticker first mapped to mint A can later become ambiguous when B is
      // verified. Retract old ticker-only attributions, but retain explicit
      // mint-address evidence and ticker associations with a unique witness.
      const withdrawn = await retractAmbiguousTickerMentions(tx);
      const recheck = new Set<string>([candidate.mint]);
      for (const row of withdrawn.rows) {
        recheck.add(row.mint);
        if (row.day) {
          const days = affected.get(row.source_id) ?? new Set<string>();
          days.add(row.day);
          affected.set(row.source_id, days);
        }
      }
      for (const mint of recheck) await recomputeFirstMention(tx, mint);
      for (const mint of recheck) await detectPropagationPatterns(tx, SOLANA_CHAIN_ID, mint);
      await tx.query("COMMIT");
      verified++;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }

  const metricsTx = await pool.connect();
  try {
    await metricsTx.query("BEGIN");
    for (const [sourceId, days] of affected) {
      await refreshTokenChannelMetrics(metricsTx, sourceId, [...days]);
    }
    await refreshChannelScores(metricsTx);
    await metricsTx.query("COMMIT");
  } catch (error) {
    await metricsTx.query("ROLLBACK");
    throw error;
  } finally {
    metricsTx.release();
  }

  console.log(JSON.stringify({ checked: candidates.rows.length, verified, rejected, deferred }));
}

main().catch(() => {
  // Do not print DB connection strings, provider responses, SQL or API keys.
  console.error("TG mint resolver failed: source_or_database_operation_failed");
  process.exitCode = 1;
}).finally(() => pool.end());
