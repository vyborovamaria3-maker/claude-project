#!/usr/bin/env node
"use strict";

// Replays persisted Helius evidence. No Excel values, network calls, or guessed PnL.
const { gunzipSync } = require("node:zlib");
const path = require("node:path");
const { parseEvidence, computePnlOrdered } = require("./blockchain-forensics-core.cjs");
const REVISION = 5;
// Bump when parseEvidence / PnL semantics change; cached raw events remain reusable.
const DECODER_VERSION = "5";

const forensicInitialized = new WeakSet();
function initForensics(db) {
  if (forensicInitialized.has(db)) return;
  db.exec([
    "CREATE TABLE IF NOT EXISTS chain_forensic_activities (",
    " wallet TEXT NOT NULL, signature TEXT NOT NULL, leg_index INTEGER NOT NULL,",
    " slot INTEGER, block_time INTEGER, kind TEXT NOT NULL, mint TEXT NOT NULL,",
    " amount_tokens REAL, amount_sol REAL, fee_sol REAL, counterparty TEXT,",
    " PRIMARY KEY(wallet,signature,leg_index))",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_trades_mint",
    " ON chain_forensic_activities(mint,kind,slot)",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_activities_wallet",
    " ON chain_forensic_activities(wallet,slot)",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_fifo_stream",
    " ON chain_forensic_activities(wallet,mint,COALESCE(slot,block_time,0),COALESCE(block_time,0),signature,leg_index)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_edges (",
    " observer_wallet TEXT NOT NULL, signature TEXT NOT NULL, leg_index INTEGER NOT NULL,",
    " mint TEXT NOT NULL, from_wallet TEXT NOT NULL, to_wallet TEXT NOT NULL,",
    " amount_tokens REAL NOT NULL,",
    " PRIMARY KEY(observer_wallet,signature,leg_index))",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_edges_from ON chain_forensic_edges(from_wallet)",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_edges_to ON chain_forensic_edges(to_wallet)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_wallet_pnl (",
    " wallet TEXT NOT NULL, mint TEXT NOT NULL, coverage_complete INTEGER NOT NULL,",
    " status TEXT NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL,",
    " transfers INTEGER NOT NULL, known_sells INTEGER NOT NULL,",
    " known_realized_pnl_sol REAL, total_realized_pnl_sol REAL,",
    " unknown_reasons TEXT NOT NULL, updated_at INTEGER NOT NULL,",
    " PRIMARY KEY(wallet,mint))",
    ";CREATE INDEX IF NOT EXISTS idx_forensic_pnl_mint ON chain_forensic_wallet_pnl(mint)",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_wallet_sync (",
    " wallet TEXT PRIMARY KEY, revision INTEGER NOT NULL, observed_count INTEGER NOT NULL,",
    " max_observed_at INTEGER NOT NULL, coverage_complete INTEGER NOT NULL,",
    " analyzed_at INTEGER NOT NULL, source_coverage_complete INTEGER NOT NULL DEFAULT 0,",
    " raw_revision_sum INTEGER NOT NULL DEFAULT 0, decoder_version TEXT NOT NULL DEFAULT 'legacy')",
    ";CREATE TABLE IF NOT EXISTS chain_forensic_processed_signatures (",
    " wallet TEXT NOT NULL, signature TEXT NOT NULL, revision INTEGER NOT NULL,",
    " undecoded_swap INTEGER NOT NULL DEFAULT 0, raw_revision INTEGER NOT NULL DEFAULT 1, decoder_version TEXT NOT NULL DEFAULT 'legacy',",
    " PRIMARY KEY(wallet,signature))",
  ].join("\n"));
  if (!db.pragma("table_info(chain_forensic_wallet_sync)").some(column => column.name === "source_coverage_complete")) {
    db.exec("ALTER TABLE chain_forensic_wallet_sync ADD COLUMN source_coverage_complete INTEGER NOT NULL DEFAULT 0");
  }
  if (!db.pragma("table_info(chain_forensic_wallet_sync)").some(column => column.name === "raw_revision_sum"))
    db.exec("ALTER TABLE chain_forensic_wallet_sync ADD COLUMN raw_revision_sum INTEGER NOT NULL DEFAULT 0");
  if (!db.pragma("table_info(chain_forensic_processed_signatures)").some(column => column.name === "raw_revision"))
    db.exec("ALTER TABLE chain_forensic_processed_signatures ADD COLUMN raw_revision INTEGER NOT NULL DEFAULT 1");
  if (!db.pragma("table_info(chain_forensic_processed_signatures)").some(column => column.name === "decoder_version"))
    db.exec("ALTER TABLE chain_forensic_processed_signatures ADD COLUMN decoder_version TEXT NOT NULL DEFAULT 'legacy'");
  if (!db.pragma("table_info(chain_forensic_wallet_sync)").some(column => column.name === "decoder_version"))
    db.exec("ALTER TABLE chain_forensic_wallet_sync ADD COLUMN decoder_version TEXT NOT NULL DEFAULT 'legacy'");

  // Read paths must never observe a previously verified PnL after raw evidence
  // changed outside the collector's usual all-in-one SQLite transaction.
  db.exec([
    "CREATE TRIGGER IF NOT EXISTS forensic_raw_insert AFTER INSERT ON chain_seed_events WHEN NEW.kind='wallet' BEGIN",
    "UPDATE chain_forensic_wallet_sync SET raw_revision_sum=-1,coverage_complete=0 WHERE wallet=NEW.address;",
    "UPDATE chain_forensic_wallet_pnl SET status='unknown',coverage_complete=0,total_realized_pnl_sol=NULL,unknown_reasons='[\"raw_evidence_pending_rebuild\"]' WHERE wallet=NEW.address; END;",
    "CREATE TRIGGER IF NOT EXISTS forensic_raw_revision AFTER UPDATE OF payload_hash,raw_revision ON chain_seed_events",
    "WHEN NEW.kind='wallet' AND (OLD.payload_hash IS NOT NEW.payload_hash OR OLD.raw_revision<>NEW.raw_revision) BEGIN",
    "UPDATE chain_forensic_wallet_sync SET raw_revision_sum=-1,coverage_complete=0 WHERE wallet=NEW.address;",
    "UPDATE chain_forensic_wallet_pnl SET status='unknown',coverage_complete=0,total_realized_pnl_sol=NULL,unknown_reasons='[\"raw_evidence_pending_rebuild\"]' WHERE wallet=NEW.address; END;",
    "CREATE TRIGGER IF NOT EXISTS forensic_raw_delete AFTER DELETE ON chain_seed_events WHEN OLD.kind='wallet' BEGIN",
    "DELETE FROM chain_forensic_activities WHERE wallet=OLD.address AND signature=OLD.signature;",
    "DELETE FROM chain_forensic_edges WHERE observer_wallet=OLD.address AND signature=OLD.signature;",
    "DELETE FROM chain_forensic_processed_signatures WHERE wallet=OLD.address AND signature=OLD.signature;",
    "UPDATE chain_forensic_wallet_sync SET raw_revision_sum=-1,coverage_complete=0 WHERE wallet=OLD.address;",
    "UPDATE chain_forensic_wallet_pnl SET status='unknown',coverage_complete=0,total_realized_pnl_sol=NULL,unknown_reasons='[\"raw_evidence_removed\"]' WHERE wallet=OLD.address; END;",
  ].join("\n"));
  forensicInitialized.add(db);
}
function walletCoverage(row) {
  return row.backfill_complete === 1 && row.possible_gap === 0
    && !row.forward_cursor && row.last_success_at != null && !row.last_error;
}

function rebuildWallet(db, wallet, force = false) {
  initForensics(db);
  // SQLite transaction spans the source snapshot, durable materialization and
  // PnL checkpoint. The collector may call this inside its own savepoint.
  // Raw gzip payloads are read in fixed-size keyset batches (not .all(wallet)).
  return db.transaction(() => {
    const target = db.prepare("SELECT * FROM chain_seed_targets WHERE kind='wallet' AND address=?").get(wallet);
    if (!target) throw new Error("Wallet is not in seed queue: " + wallet);
    const summary = db.prepare(
      "SELECT COUNT(*) AS n,COALESCE(MAX(observed_at),0) AS latest,MIN(slot) AS oldestSlot," +
      "COALESCE(SUM(raw_revision),0) AS revisionSum FROM chain_seed_events WHERE kind='wallet' AND address=?"
    ).get(wallet);
    // Helius owner metadata for token-account discovery is incomplete in older epochs.
    const legacyAtaGap = summary.oldestSlot != null && summary.oldestSlot < 111491819;
    const complete = walletCoverage(target) && !legacyAtaGap;
    const cached = db.prepare("SELECT * FROM chain_forensic_wallet_sync WHERE wallet=?").get(wallet);
    const canIncrement = !force && cached && cached.revision === REVISION && cached.decoder_version === DECODER_VERSION;
    if (canIncrement && cached.observed_count === summary.n &&
        cached.max_observed_at === summary.latest &&
        cached.raw_revision_sum === summary.revisionSum &&
        Boolean(cached.source_coverage_complete) === complete) {
      return { wallet, skipped: true, transactions: summary.n,
        coverageComplete: Boolean(cached.coverage_complete) };
    }

    const putSignature = db.prepare(
      "INSERT INTO chain_forensic_processed_signatures(wallet,signature,revision,undecoded_swap,raw_revision,decoder_version) " +
      "VALUES(?,?,?,?,?,?) ON CONFLICT(wallet,signature) DO UPDATE SET " +
      "revision=excluded.revision,undecoded_swap=excluded.undecoded_swap,raw_revision=excluded.raw_revision,decoder_version=excluded.decoder_version"
    );
    const insertEvent = db.prepare(
      "INSERT INTO chain_forensic_activities(wallet,signature,leg_index,slot,block_time,kind,mint,amount_tokens,amount_sol,fee_sol,counterparty) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    );
    const insertEdge = db.prepare(
      "INSERT INTO chain_forensic_edges(observer_wallet,signature,leg_index,mint,from_wallet,to_wallet,amount_tokens) VALUES(?,?,?,?,?,?,?)"
    );
    if (!canIncrement) {
      db.prepare("DELETE FROM chain_forensic_activities WHERE wallet=?").run(wallet);
      db.prepare("DELETE FROM chain_forensic_edges WHERE observer_wallet=?").run(wallet);
      db.prepare("DELETE FROM chain_forensic_processed_signatures WHERE wallet=?").run(wallet);
    } else {
      db.prepare("DELETE FROM chain_forensic_activities WHERE wallet=? AND NOT EXISTS (SELECT 1 FROM chain_seed_events e WHERE e.kind='wallet' AND e.address=chain_forensic_activities.wallet AND e.signature=chain_forensic_activities.signature)").run(wallet);
      db.prepare("DELETE FROM chain_forensic_edges WHERE observer_wallet=? AND NOT EXISTS (SELECT 1 FROM chain_seed_events e WHERE e.kind='wallet' AND e.address=chain_forensic_edges.observer_wallet AND e.signature=chain_forensic_edges.signature)").run(wallet);
      db.prepare("DELETE FROM chain_forensic_processed_signatures WHERE wallet=? AND NOT EXISTS (SELECT 1 FROM chain_seed_events e WHERE e.kind='wallet' AND e.address=chain_forensic_processed_signatures.wallet AND e.signature=chain_forensic_processed_signatures.signature)").run(wallet);
    }
    const rawBatch = canIncrement ? db.prepare(
      "SELECT e.signature,e.payload_gzip,e.raw_revision FROM chain_seed_events e " +
      "LEFT JOIN chain_forensic_processed_signatures p ON p.wallet=e.address AND p.signature=e.signature " +
      "WHERE e.kind='wallet' AND e.address=? AND (p.signature IS NULL OR p.revision<>? OR p.raw_revision<>e.raw_revision) " +
      "AND e.signature>? ORDER BY e.signature LIMIT ?"
    ) : db.prepare(
      "SELECT signature,payload_gzip,raw_revision FROM chain_seed_events " +
      "WHERE kind='wallet' AND address=? AND signature>? ORDER BY signature LIMIT ?"
    );
    const deleteEvent=db.prepare("DELETE FROM chain_forensic_activities WHERE wallet=? AND signature=?");
    const deleteEdge=db.prepare("DELETE FROM chain_forensic_edges WHERE observer_wallet=? AND signature=?");
    let newlyParsed=0, lastSignature="";
    let undecodedSwap = canIncrement ? db.prepare(
      "SELECT COUNT(*) AS count FROM chain_forensic_processed_signatures p " +
      "INNER JOIN chain_seed_events e ON e.kind='wallet' AND e.address=p.wallet AND e.signature=p.signature " +
      "WHERE p.wallet=? AND p.revision=? AND p.undecoded_swap=1 AND p.raw_revision=e.raw_revision"
    ).get(wallet,REVISION).count>0 : false;
    while (true) {
      // Full wallet backfill can be millions of transactions; never read them all
      // into a JS array. A batch is fully consumed before another DB write.
      const rows=canIncrement ? rawBatch.all(wallet,REVISION,lastSignature,200) :
        rawBatch.all(wallet,lastSignature,200);
      if (!rows.length) break;
      for (const row of rows) {
        let tx;
        try { tx=JSON.parse(gunzipSync(row.payload_gzip,{maxOutputLength:512*1024}).toString("utf8")); }
        catch (error) { throw new Error("Invalid cached transaction "+row.signature+": "+String(error)); }
        if (tx.signature!==row.signature) throw new Error("Cached signature mismatch: "+row.signature);
        const decoded=parseEvidence(tx,wallet);
        const undecoded=tx.transactionError==null && tx.error==null &&
          ((tx.type==="SWAP" && (!tx.events?.swap || decoded.length===0)) ||
          (tx.type==="UNKNOWN" && !Array.isArray(tx.accountData)));
        if (undecoded) undecodedSwap=true;
        if (canIncrement) {
          deleteEvent.run(wallet,row.signature);
          deleteEdge.run(wallet,row.signature);
        }
        putSignature.run(wallet,row.signature,REVISION,undecoded?1:0,row.raw_revision,DECODER_VERSION);
        for (const ev of decoded) {
          insertEvent.run(wallet,ev.signature,ev.index,ev.slot,ev.timestamp,ev.kind,
            ev.mint,ev.amountTokens,ev.amountSol,ev.feeSol,ev.counterparty);
          if (["transfer_in","transfer_out","sol_transfer_in","sol_transfer_out"].includes(ev.kind) && ev.counterparty) {
            insertEdge.run(wallet,ev.signature,ev.index,ev.mint,
              ev.kind.endsWith("_out")?wallet:ev.counterparty,
              ev.kind.endsWith("_in")?wallet:ev.counterparty,ev.amountTokens);
          }
        }
        newlyParsed++;
      }
      lastSignature=rows[rows.length-1].signature;
    }
    const evidenceComplete=complete && !undecodedSwap;
    // SQL iteration is ordered and closed before DELETE/INSERT of PnL rows.
    const pnl=computePnlOrdered(db.prepare(
      "SELECT signature,slot,block_time AS timestamp,leg_index AS event_index,kind,mint," +
      "amount_tokens AS amountTokens,amount_sol AS amountSol,fee_sol AS feeSol,counterparty " +
      "FROM chain_forensic_activities WHERE wallet=? " +
      "ORDER BY mint,COALESCE(slot,block_time,0),COALESCE(block_time,0),signature,leg_index"
    ).iterate(wallet),evidenceComplete);
    if (legacyAtaGap) for (const item of pnl) item.reasons.push("pre_owner_metadata_ata_gap");
    if (undecodedSwap) for (const item of pnl) {
      item.reasons.push("undecoded_swap_in_wallet_history");
      item.status="unknown";item.totalRealizedPnlSol=null;
    }
    const eventStats=db.prepare(
      "SELECT COUNT(*) AS activities,SUM(CASE WHEN kind IN ('buy','sell') THEN 1 ELSE 0 END) AS priced " +
      "FROM chain_forensic_activities WHERE wallet=?"
    ).get(wallet);
    db.prepare("DELETE FROM chain_forensic_wallet_pnl WHERE wallet=?").run(wallet);
    const insertPnl=db.prepare(
      "INSERT INTO chain_forensic_wallet_pnl(wallet,mint,coverage_complete,status,buys,sells,transfers,known_sells,known_realized_pnl_sol,total_realized_pnl_sol,unknown_reasons,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    const now=Date.now();
    for (const item of pnl) {
      insertPnl.run(wallet,item.mint,evidenceComplete?1:0,item.status,item.buys,
        item.sells,item.transfers,item.knownSellCount,item.knownRealizedPnlSol,
        item.totalRealizedPnlSol,JSON.stringify(item.reasons),now);
    }
    db.prepare(
      "INSERT INTO chain_forensic_wallet_sync(wallet,revision,observed_count,max_observed_at,coverage_complete,analyzed_at,source_coverage_complete,raw_revision_sum,decoder_version) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET revision=excluded.revision,observed_count=excluded.observed_count,max_observed_at=excluded.max_observed_at,coverage_complete=excluded.coverage_complete,analyzed_at=excluded.analyzed_at,source_coverage_complete=excluded.source_coverage_complete,raw_revision_sum=excluded.raw_revision_sum,decoder_version=excluded.decoder_version"
    ).run(wallet,REVISION,summary.n,summary.latest,evidenceComplete?1:0,now,complete?1:0,summary.revisionSum,DECODER_VERSION);
    return { wallet, skipped:false, transactions:summary.n,newlyParsed,
      activities:eventStats.activities,pricedTrades:eventStats.priced||0,
      coverageComplete:evidenceComplete,verifiedTokens:pnl.filter(p=>p.status==="verified").length,
      unknownTokens:pnl.filter(p=>p.status==="unknown").length };
  })();
}

function rebuildAll(db, limit = 100, force = false) {
  require("./blockchain-seed-collector.cjs").initDb(db);
  initForensics(db);
  const wallets = db.prepare(
    "SELECT t.address FROM chain_seed_targets t LEFT JOIN chain_forensic_wallet_sync s ON s.wallet=t.address WHERE t.kind='wallet' AND t.source_mask<>0 ORDER BY COALESCE(s.analyzed_at,0) ASC,t.priority DESC,t.address LIMIT ?"
  ).all(limit);
  const completed = [], errors = [];
  for (const row of wallets) {
    try { completed.push(rebuildWallet(db, row.address, force)); }
    catch (e) { errors.push({ wallet: row.address, error: String(e.message || e) }); }
  }
  return { processed: completed.length, errors, wallets: completed,
    totals: db.prepare(
      "SELECT COUNT(*) AS walletsAndMints, SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified, SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown FROM chain_forensic_wallet_pnl"
    ).get() };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex < 0 ? 100 : Number(args[limitIndex + 1]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new Error("Invalid --limit");
  require("dotenv").config({ path: path.join(process.cwd(), ".env.local"), quiet: true });
  require("ts-node").register({ skipProject: true, transpileOnly: true,
    compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true } });
  const db = require("../lib/trade/db").getDb();
  const result = rebuildAll(db, limit, args.includes("--force"));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
module.exports = { REVISION, DECODER_VERSION, initForensics, walletCoverage, rebuildWallet, rebuildAll };
