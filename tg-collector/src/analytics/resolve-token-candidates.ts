import "dotenv/config";
import { createHash } from "node:crypto";
import { emitVerifiedTgTokenLinkOutbox } from "../persistence/outbox.js";
import { pool, migrate } from "../db.js";
import { ANALYSIS_VERSION } from "./extract.js";
import { detectPropagationPatterns, refreshChannelScores, refreshTokenChannelMetrics, SOLANA_CHAIN_ID } from "./token-intelligence.js";
import { syncTokenNarratives } from "./narratives.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
type AccountInfo = { owner?: string; data?: [string, string] | string[] } | null;

async function readMintAccount(rpcUrl: string, mint: string): Promise<{ decimals: number; owner: string } | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [mint, { encoding: "base64", commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Alchemy RPC returned HTTP " + response.status);
  const body = await response.json() as {
    result?: { value?: AccountInfo };
    error?: { message?: string; code?: number };
  };
  if (body.error) throw new Error("Alchemy RPC error " + String(body.error.code ?? "") + ": " + (body.error.message ?? "unknown"));
  const account = body.result?.value;
  if (!account) return null;
  if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) return null;
  const encoded = Array.isArray(account.data) ? account.data[0] : undefined;
  if (!encoded || typeof encoded !== "string") return null;
  const data = Buffer.from(encoded, "base64");
  // SPL Mint base layout: supply at byte 36, decimals at 44, initialized at 45.
  // Token accounts are longer and do not have the Mint initialized byte at this offset.
  if (data.length < 82 || data[45] !== 1 || data[44] > 30) return null;
  return { decimals: data[44], owner: account.owner };
}

async function recomputeFirstMention(tx: import("pg").PoolClient, mint: string): Promise<void> {
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
    "SELECT DISTINCT candidate_key AS mint FROM tg_token_candidates " +
    "WHERE chain_id=$1 AND candidate_type='address' AND resolution_status='unresolved' " +
    "ORDER BY candidate_key LIMIT $2",
    [SOLANA_CHAIN_ID, limit],
  );
  let verified = 0;
  let rejected = 0;
  let deferred = 0;
  const affected = new Map<string, Set<string>>();

  for (const candidate of candidates.rows) {
    let mintInfo: { decimals: number; owner: string } | null;
    try {
      mintInfo = await readMintAccount(rpcUrl, candidate.mint);
    } catch (error) {
      deferred++;
      console.warn("Mint check deferred; candidate remains unresolved:", candidate.mint,
        error instanceof Error ? error.message : String(error));
      continue;
    }

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      if (!mintInfo) {
        await tx.query(
          "UPDATE tg_token_candidates SET resolution_status='not_token',confidence=0.95," +
          "provider='alchemy-solana-rpc',checked_at=now() WHERE chain_id=$1 AND candidate_type='address' " +
          "AND candidate_key=$2 AND resolution_status='unresolved'",
          [SOLANA_CHAIN_ID, candidate.mint],
        );
        rejected++;
        await tx.query("COMMIT");
        continue;
      }

      await tx.query(
        "INSERT INTO tg_tokens(chain_id,mint,decimals,token_program,metadata_status,metadata_provider,metadata_updated_at) " +
        "VALUES($1,$2,$3,$4,'partial','alchemy-solana-rpc',now()) " +
        "ON CONFLICT(chain_id,mint) DO UPDATE SET decimals=EXCLUDED.decimals,token_program=EXCLUDED.token_program," +
        "metadata_provider=EXCLUDED.metadata_provider,metadata_updated_at=now()",
        [SOLANA_CHAIN_ID, candidate.mint, mintInfo.decimals, mintInfo.owner],
      );
      await tx.query(
        "UPDATE tg_token_candidates SET resolution_status='confirmed_token',confidence=1," +
        "provider='alchemy-solana-rpc',checked_at=now() WHERE chain_id=$1 AND candidate_type='address' " +
        "AND candidate_key=$2",
        [SOLANA_CHAIN_ID, candidate.mint],
      );

      const occurrences = await tx.query<{
        source_id: string; message_id: string; message_date: Date | null; tickers: string[]; text: string;
        peer_id: string|null; edited_at: Date|null;
      }>(
        "SELECT c.source_id::text,c.message_id::text,m.posted_at AS message_date,m.text," +
        "s.peer_id::text AS peer_id,m.edited_at," +
        "COALESCE(array_agg(DISTINCT t.ticker) FILTER (WHERE t.ticker IS NOT NULL),'{}') AS tickers " +
        "FROM tg_token_candidates c JOIN tg_messages m USING(source_id,message_id) " +
        "JOIN tg_sources s ON s.id=c.source_id " +
        "LEFT JOIN tg_ticker_mentions t ON t.source_id=c.source_id AND t.message_id=c.message_id " +
        "AND t.chain_id=c.chain_id AND t.analysis_version=$3 " +
        "WHERE c.chain_id=$1 AND c.candidate_type='address' AND c.candidate_key=$2 " +
        "AND c.analysis_version=$3 AND m.deleted_at IS NULL " +
        "GROUP BY c.source_id,c.message_id,m.posted_at,m.text,s.peer_id,m.edited_at",
        [SOLANA_CHAIN_ID, candidate.mint, ANALYSIS_VERSION],
      );
      for (const occurrence of occurrences.rows) {
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
        if (occurrence.peer_id && occurrence.text.includes(candidate.mint)) {
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
      await recomputeFirstMention(tx, candidate.mint);
      await detectPropagationPatterns(tx, SOLANA_CHAIN_ID, candidate.mint);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => pool.end());
