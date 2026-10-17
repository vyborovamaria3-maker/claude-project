"use strict";

// Local-first, idempotent wallet-wide trade cache for the Solana seed collector.
// Raw Helius events remain the evidence layer; this module stores decoded swap legs
// and conservative summaries without asserting that an incomplete wallet history is complete.
const DECODER_VERSION = "wallet-trades-v1";

function createWalletCacheTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_wallet_discovery (
      wallet TEXT PRIMARY KEY,
      chain TEXT NOT NULL DEFAULT 'solana',
      discovered_via_token TEXT,
      discovered_via_wallet TEXT,
      discovered_via_kind TEXT NOT NULL DEFAULT 'unknown',
      first_discovered_at INTEGER NOT NULL,
      history_status TEXT NOT NULL DEFAULT 'not_fetched'
        CHECK(history_status IN ('not_fetched','partial','complete','error')),
      last_fetched_at INTEGER,
      backfill_cursor TEXT,
      forward_cursor TEXT,
      backfill_complete INTEGER NOT NULL DEFAULT 0,
      possible_gap INTEGER NOT NULL DEFAULT 0,
      tokens_touched INTEGER NOT NULL DEFAULT 0,
      last_trade_at INTEGER,
      last_error TEXT,
      decoder_coverage TEXT NOT NULL DEFAULT 'swap_only'
        CHECK(decoder_coverage IN ('swap_only','swap_and_transfers','swap_transfers_mint_burn','full')),
      last_decoder_version TEXT NOT NULL DEFAULT 'wallet-trades-v1'
    );
    CREATE INDEX IF NOT EXISTS idx_chain_wallet_discovery_freshness
      ON chain_wallet_discovery(history_status, last_fetched_at);
    CREATE TABLE IF NOT EXISTS chain_wallet_trades (
      id INTEGER PRIMARY KEY,
      wallet TEXT NOT NULL,
      chain TEXT NOT NULL DEFAULT 'solana',
      signature TEXT NOT NULL,
      leg_key TEXT NOT NULL,
      instruction_index INTEGER,
      slot INTEGER,
      block_time INTEGER,
      commitment_level TEXT NOT NULL DEFAULT 'confirmed',
      token_mint TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('buy','sell','transfer_in','transfer_out','mint','burn')),
      amount_tokens TEXT,
      amount_sol TEXT,
      price_usd_at_time TEXT,
      fee_lamports INTEGER,
      protocol_fee_lamports INTEGER,
      dex TEXT,
      pool TEXT,
      counterparty TEXT,
      decoder_version TEXT NOT NULL,
      source_provider TEXT NOT NULL DEFAULT 'helius',
      raw_event_kind TEXT NOT NULL DEFAULT 'wallet',
      raw_event_address TEXT NOT NULL,
      raw_event_signature TEXT NOT NULL,
      raw_event_slot INTEGER,
      reorg_status TEXT NOT NULL DEFAULT 'pending_confirmation'
        CHECK(reorg_status IN ('stable','reorged','pending_confirmation')),
      finalized_at INTEGER,
      decoder_coverage TEXT NOT NULL DEFAULT 'swap_only'
        CHECK(decoder_coverage IN ('swap_only','swap_and_transfers','swap_transfers_mint_burn','full')),
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok'
        CHECK(status IN ('ok','disputed','reorged','undecoded')),
      UNIQUE(wallet, chain, signature, leg_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_wallet_trades_wallet_mint_time
      ON chain_wallet_trades(wallet, token_mint, block_time);
    CREATE INDEX IF NOT EXISTS idx_chain_wallet_trades_mint_time
      ON chain_wallet_trades(token_mint, block_time);
    CREATE INDEX IF NOT EXISTS idx_chain_wallet_trades_wallet_time
      ON chain_wallet_trades(wallet, block_time);
    CREATE INDEX IF NOT EXISTS idx_chain_wallet_trades_signature
      ON chain_wallet_trades(signature, leg_key);
    CREATE TABLE IF NOT EXISTS chain_wallet_token_summary (
      wallet TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      trades_count INTEGER NOT NULL DEFAULT 0,
      first_trade_at INTEGER,
      last_trade_at INTEGER,
      bought_amount TEXT NOT NULL DEFAULT '0',
      sold_amount TEXT NOT NULL DEFAULT '0',
      realized_pnl TEXT,
      unrealized_pnl TEXT,
      decoder_coverage TEXT NOT NULL DEFAULT 'swap_only'
        CHECK(decoder_coverage IN ('swap_only','swap_and_transfers','swap_transfers_mint_burn','full')),
      unknown_operations_count INTEGER NOT NULL DEFAULT 0,
      unknown_operations_ratio REAL NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(status IN ('verified','unknown')),
      data_confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(wallet, token_mint)
    );
    CREATE TABLE IF NOT EXISTS chain_wallet_token_touched (
      wallet TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      last_trade_at INTEGER,
      trade_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'discovered_via_wallet',
      PRIMARY KEY(wallet, token_mint)
    );
    CREATE TABLE IF NOT EXISTS chain_history_coverage (
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('wallet','token')),
      entity_key TEXT NOT NULL,
      source TEXT NOT NULL,
      coverage_start_slot INTEGER,
      coverage_end_slot INTEGER,
      events_count INTEGER NOT NULL DEFAULT 0,
      expected_count INTEGER,
      coverage_percent REAL CHECK(coverage_percent IS NULL OR (coverage_percent >= 0 AND coverage_percent <= 1)),
      status TEXT NOT NULL CHECK(status IN ('complete','partial','gap','error')),
      decoder_coverage TEXT NOT NULL DEFAULT 'swap_only'
        CHECK(decoder_coverage IN ('swap_only','swap_and_transfers','swap_transfers_mint_burn','full')),
      gap_reason TEXT,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY(entity_kind, entity_key, source)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_history_coverage_status
      ON chain_history_coverage(status, checked_at);
    CREATE TABLE IF NOT EXISTS chain_budget_ledger (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      cost_units REAL,
      cost_kind TEXT NOT NULL CHECK(cost_kind IN ('credit','cu','http')),
      task_id TEXT,
      entity_kind TEXT,
      entity_key TEXT,
      ts INTEGER NOT NULL,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chain_budget_ledger_provider_ts
      ON chain_budget_ledger(provider, ts);
    CREATE INDEX IF NOT EXISTS idx_chain_budget_ledger_entity
      ON chain_budget_ledger(entity_kind, entity_key, ts);
    CREATE TABLE IF NOT EXISTS chain_wallet_pagination_state (
      wallet TEXT PRIMARY KEY,
      pagination_kind TEXT NOT NULL DEFAULT 'before'
        CHECK(pagination_kind IN ('before','until','page_number')),
      pagination_token TEXT,
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      last_page_empty INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chain_wallet_cluster_candidates (
      wallet_a TEXT NOT NULL,
      wallet_b TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      evidence_ref TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','rejected','reviewed')),
      PRIMARY KEY(wallet_a, wallet_b, evidence_type),
      CHECK(wallet_a < wallet_b)
    );
    CREATE TABLE IF NOT EXISTS chain_wallet_smart_money_metrics (
      wallet TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      early_entry_ratio REAL,
      win_rate REAL,
      median_hold_time_sec REAL,
      trade_size_median REAL,
      wallet_age_days REAL,
      tokens_touched INTEGER,
      cluster_size INTEGER,
      confidence_low REAL,
      confidence_high REAL,
      calculated_at INTEGER NOT NULL
    );
  `);
}

function ensureColumn(db, table, column, declaration) {
  if (!db.pragma("table_info(" + table + ")").some(row => row.name === column)) {
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + declaration);
  }
}

function ensureWalletCacheSchema(db) {
  createWalletCacheTables(db);
  db.exec("PRAGMA foreign_keys = ON");
  // CREATE TABLE above handles new databases; these additive migrations also support
  // existing local pilot databases without dropping or rebuilding user data.
  ensureColumn(db, "chain_wallet_discovery", "decoder_coverage", "TEXT NOT NULL DEFAULT 'swap_only'");
  ensureColumn(db, "chain_wallet_discovery", "last_decoder_version", "TEXT NOT NULL DEFAULT 'wallet-trades-v1'");
  ensureColumn(db, "chain_wallet_trades", "raw_event_signature", "TEXT");
  ensureColumn(db, "chain_wallet_trades", "raw_event_slot", "INTEGER");
  ensureColumn(db, "chain_wallet_trades", "reorg_status", "TEXT NOT NULL DEFAULT 'pending_confirmation'");
  ensureColumn(db, "chain_wallet_trades", "finalized_at", "INTEGER");
  ensureColumn(db, "chain_wallet_trades", "decoder_coverage", "TEXT NOT NULL DEFAULT 'swap_only'");
  ensureColumn(db, "chain_wallet_token_summary", "decoder_coverage", "TEXT NOT NULL DEFAULT 'swap_only'");
  ensureColumn(db, "chain_wallet_token_summary", "unknown_operations_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "chain_wallet_token_summary", "unknown_operations_ratio", "REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "chain_wallet_token_touched", "source", "TEXT NOT NULL DEFAULT 'discovered_via_wallet'");
  db.exec(`
    UPDATE chain_wallet_trades SET raw_event_signature=signature WHERE raw_event_signature IS NULL;
    CREATE INDEX IF NOT EXISTS idx_chain_wallet_discovery_freshness
      ON chain_wallet_discovery(history_status, last_fetched_at);
  `);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cacheWalletTrades(db, wallet, transactions, txsToTrades, options = {}) {
  ensureWalletCacheSchema(db);
  if (typeof wallet !== 'string' || !wallet) throw new Error('wallet is required');
  if (typeof txsToTrades !== 'function') throw new Error('txsToTrades decoder is required');
  const now = options.now ?? Date.now();
  const decoderVersion = options.decoderVersion || DECODER_VERSION;
  const provider = options.sourceProvider || 'helius';
  const insert = db.prepare(`
    INSERT INTO chain_wallet_trades (
      wallet, chain, signature, leg_key, instruction_index, slot, block_time,
      commitment_level, token_mint, direction, amount_tokens, amount_sol,
      fee_lamports, dex, pool, counterparty, decoder_version, source_provider,
      raw_event_kind, raw_event_address, raw_event_signature, raw_event_slot,
      reorg_status, finalized_at, decoder_coverage, first_seen_at, last_seen_at, status
    ) VALUES (
      @wallet, 'solana', @signature, @leg_key, @instruction_index, @slot, @block_time,
      'confirmed', @token_mint, @direction, @amount_tokens, @amount_sol,
      @fee_lamports, @dex, @pool, @counterparty, @decoder_version, @source_provider,
      'wallet', @wallet, @signature, @slot, 'pending_confirmation', NULL, 'swap_only',
      @now, @now, 'ok'
    )
    ON CONFLICT(wallet, chain, signature, leg_key) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      slot=COALESCE(excluded.slot, chain_wallet_trades.slot),
      block_time=COALESCE(excluded.block_time, chain_wallet_trades.block_time),
      amount_tokens=COALESCE(excluded.amount_tokens, chain_wallet_trades.amount_tokens),
      amount_sol=COALESCE(excluded.amount_sol, chain_wallet_trades.amount_sol),
      fee_lamports=COALESCE(excluded.fee_lamports, chain_wallet_trades.fee_lamports),
      decoder_version=excluded.decoder_version,
      source_provider=excluded.source_provider
  `);
  const tokenMints = new Set();
  let insertedOrUpdated = 0;
  const tx = db.transaction(() => {
    for (const event of transactions || []) {
      if (!event || event.transactionError != null || typeof event.signature !== 'string' || !event.signature) continue;
      const swap = event.events && event.events.swap;
      const mints = new Set();
      // Token transfers are discovery evidence even when the swap decoder cannot
      // assign a BUY/SELL. They must not silently disappear from wallet coverage.
      for (const transfer of event.tokenTransfers || []) {
        if (transfer && (transfer.fromUserAccount === wallet || transfer.toUserAccount === wallet)
            && transfer.mint) mints.add(transfer.mint);
      }
      for (const leg of [...(swap?.tokenInputs || []), ...(swap?.tokenOutputs || [])]) {
        if (leg && leg.mint && leg.userAccount === wallet) mints.add(leg.mint);
      }
      for (const mint of mints) {
        if (typeof mint === 'string' && mint) tokenMints.add(mint);
        if (typeof mint !== 'string') continue;
        const trades = txsToTrades([event], mint) || [];
        let legIndex = 0;
        for (const trade of trades) {
          if (!trade || !['buy','sell'].includes(String(trade.type).toLowerCase())) continue;
          // Only cache a trade when the decoder positively identifies this wallet as the trader.
          // Missing trader identity is ambiguous and must not contaminate wallet-level FIFO.
          if (!trade.trader || trade.trader !== wallet) continue;
          const direction = String(trade.type).toLowerCase();
          const tradeSignature = trade.signature || event.signature;
          // Never persist a decoded trade against a different source transaction.
          if (tradeSignature !== event.signature) continue;
          // Stable across replay; legIndex distinguishes multiple same-direction legs for a mint.
          const legKey = mint + ':' + direction + ':' + legIndex++;
          const result = insert.run({
            wallet,
            signature: tradeSignature,
            leg_key: legKey,
            instruction_index: finiteNumber(trade.instructionIndex),
            slot: finiteNumber(trade.slot ?? event.slot),
            block_time: finiteNumber(trade.timestamp ?? event.timestamp),
            token_mint: mint,
            direction,
            amount_tokens: trade.amountTokens == null ? null : String(trade.amountTokens),
            amount_sol: trade.amountSol == null ? null : String(trade.amountSol),
            fee_lamports: finiteNumber(trade.feeLamports),
            dex: trade.dex || (swap?.programInfo && swap.programInfo.source) || null,
            pool: trade.pool || null,
            counterparty: trade.counterparty || null,
            decoder_version: decoderVersion,
            source_provider: provider,
            now
          });
          insertedOrUpdated += result.changes;
          tokenMints.add(mint);
        }
      }
    }
    for (const mint of tokenMints) {
      const rows = db.prepare(`
        SELECT direction, amount_tokens, block_time FROM chain_wallet_trades
        WHERE wallet=? AND token_mint=? AND status='ok' AND direction IN ('buy','sell')
      `).all(wallet, mint);
      let bought = 0, sold = 0, first = null, last = null;
      for (const row of rows) {
        const amount = Number(row.amount_tokens);
        if (Number.isFinite(amount)) {
          if (row.direction === 'buy') bought += amount;
          if (row.direction === 'sell') sold += amount;
        }
        if (row.block_time != null) {
          first = first == null ? row.block_time : Math.min(first, row.block_time);
          last = last == null ? row.block_time : Math.max(last, row.block_time);
        }
      }
      db.prepare(`
        INSERT INTO chain_wallet_token_summary
          (wallet, token_mint, trades_count, first_trade_at, last_trade_at, bought_amount, sold_amount,
         decoder_coverage, unknown_operations_count, unknown_operations_ratio, status, data_confidence)
        VALUES(?,?,?,?,?,?,?,'swap_only',0,1,'unknown',0)
        ON CONFLICT(wallet, token_mint) DO UPDATE SET
          trades_count=excluded.trades_count, first_trade_at=excluded.first_trade_at,
          last_trade_at=excluded.last_trade_at, bought_amount=excluded.bought_amount,
          sold_amount=excluded.sold_amount, status='unknown', data_confidence=0
      `).run(wallet, mint, rows.length, first, last, String(bought), String(sold));
      db.prepare(`
        INSERT INTO chain_wallet_token_touched(wallet, token_mint, last_trade_at, trade_count, source)
        VALUES(?,?,?,?,'discovered_via_wallet')
        ON CONFLICT(wallet, token_mint) DO UPDATE SET
          last_trade_at=excluded.last_trade_at, trade_count=excluded.trade_count
      `).run(wallet, mint, last, rows.length);
    }
    db.prepare(`
      INSERT INTO chain_wallet_discovery
        (wallet, chain, first_discovered_at, history_status, tokens_touched, last_trade_at,
         decoder_coverage, last_decoder_version)
      VALUES(?, 'solana', ?, 'partial', ?, ?, 'swap_only', ?)
      ON CONFLICT(wallet) DO UPDATE SET
        tokens_touched=MAX(chain_wallet_discovery.tokens_touched, excluded.tokens_touched),
        last_trade_at=MAX(COALESCE(chain_wallet_discovery.last_trade_at,0), COALESCE(excluded.last_trade_at,0)),
        decoder_coverage='swap_only', last_decoder_version=excluded.last_decoder_version
    `).run(wallet, now, db.prepare('SELECT COUNT(*) AS n FROM chain_wallet_token_touched WHERE wallet=?').get(wallet).n,
      db.prepare('SELECT MAX(block_time) AS t FROM chain_wallet_trades WHERE wallet=?').get(wallet).t, decoderVersion);
  });
  tx();
  return { upserted: insertedOrUpdated, tokenMints: [...tokenMints] };
}

function markWalletHistory(db, wallet, state) {
  ensureWalletCacheSchema(db);
  const now = state.now ?? Date.now();
  const decoderCoverage = state.decoderCoverage || 'swap_only';
  const complete = Boolean(state.complete && decoderCoverage === 'full'
    && !state.forwardCursor && !state.possibleGap);
  db.prepare(`
    INSERT INTO chain_wallet_discovery
      (wallet, chain, first_discovered_at, history_status, last_fetched_at, backfill_cursor,
       forward_cursor, backfill_complete, possible_gap, tokens_touched, last_trade_at, last_error,
       decoder_coverage, last_decoder_version)
    VALUES(?, 'solana', ?, ?, ?, ?, ?, ?, ?,
      (SELECT COUNT(*) FROM chain_wallet_token_touched WHERE wallet=?),
      (SELECT MAX(block_time) FROM chain_wallet_trades WHERE wallet=?), ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET
      history_status=excluded.history_status, last_fetched_at=excluded.last_fetched_at,
      backfill_cursor=excluded.backfill_cursor, forward_cursor=excluded.forward_cursor,
      backfill_complete=excluded.backfill_complete, possible_gap=excluded.possible_gap,
      tokens_touched=excluded.tokens_touched, last_trade_at=excluded.last_trade_at,
      last_error=excluded.last_error, decoder_coverage=excluded.decoder_coverage,
      last_decoder_version=excluded.last_decoder_version
  `).run(wallet, now, complete ? 'complete' : 'partial', now, state.backfillCursor || null,
    state.forwardCursor || null, complete ? 1 : 0, state.possibleGap ? 1 : 0, wallet, wallet,
    state.lastError || null, decoderCoverage, state.decoderVersion || DECODER_VERSION);
  const row = db.prepare(`
    SELECT MIN(slot) AS start_slot, MAX(slot) AS end_slot, COUNT(*) AS n
    FROM chain_seed_events WHERE kind='wallet' AND address=?
  `).get(wallet);
  db.prepare(`
    INSERT INTO chain_history_coverage
      (entity_kind, entity_key, source, coverage_start_slot, coverage_end_slot, events_count,
       expected_count, coverage_percent, status, decoder_coverage, gap_reason, checked_at)
    VALUES('wallet', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    ON CONFLICT(entity_kind, entity_key, source) DO UPDATE SET
      coverage_start_slot=excluded.coverage_start_slot, coverage_end_slot=excluded.coverage_end_slot,
      events_count=excluded.events_count, expected_count=NULL, coverage_percent=NULL,
      status=excluded.status, decoder_coverage=excluded.decoder_coverage,
      gap_reason=excluded.gap_reason, checked_at=excluded.checked_at
  `).run(wallet, state.source || 'helius', row.start_slot, row.end_slot, row.n,
    complete ? 'complete' : (state.possibleGap ? 'gap' : 'partial'), decoderCoverage,
    state.possibleGap ? 'pagination_gap' : decoderCoverage !== 'full' ? 'decoder_limit' : null, now);
  const pages = Math.max(0, Number(state.pagesFetched) || 0);
  db.prepare(`
    INSERT INTO chain_wallet_pagination_state(wallet, pagination_kind, pagination_token, pages_fetched, last_page_empty, updated_at)
    VALUES(?, 'before', ?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET pagination_kind=excluded.pagination_kind,
      pagination_token=excluded.pagination_token, pages_fetched=chain_wallet_pagination_state.pages_fetched+excluded.pages_fetched,
      last_page_empty=excluded.last_page_empty, updated_at=excluded.updated_at
  `).run(wallet, state.backfillCursor || null, pages, state.lastPageEmpty ? 1 : 0, now);
}

function walletHistoryFresh(db, wallet, now = Date.now()) {
  ensureWalletCacheSchema(db);
  const row = db.prepare(`
    SELECT history_status, last_fetched_at, last_trade_at, decoder_coverage
    FROM chain_wallet_discovery WHERE wallet=?
  `).get(wallet);
  if (!row || row.history_status !== 'complete' || row.decoder_coverage !== 'full'
      || row.last_fetched_at == null) return false;
  const active = row.last_trade_at != null && row.last_trade_at >= Math.floor((now - 24 * 3600_000) / 1000);
  const threshold = active ? 2 * 3600_000 : 24 * 3600_000;
  return now - row.last_fetched_at < threshold;
}

function authoritativePnlAllowed(signals = {}) {
  return signals.historyComplete === true
    && signals.decoderCoverage === 'full'
    && signals.costBasisComplete === true
    && signals.completeFromObservedTrades === true
    && signals.orderingComplete === true
    && signals.reorgStable === true
    && Number.isFinite(signals.unknownOperationsRatio)
    && signals.unknownOperationsRatio <= 0.05;
}

function calculateDataConfidence(signals = {}) {
  const history = signals.historyComplete === true ? 1 : 0;
  const coverageMap = { swap_only: 0.25, swap_and_transfers: 0.6, swap_transfers_mint_burn: 0.8, full: 1 };
  const decoder = coverageMap[signals.decoderCoverage] || 0;
  const unknown = Number.isFinite(signals.unknownOperationsRatio)
    ? Math.max(0, Math.min(1, 1 - signals.unknownOperationsRatio)) : 0;
  const costBasis = signals.costBasisComplete === true ? 1 : 0;
  const ordering = signals.orderingComplete === true ? 1 : 0;
  const reorg = signals.reorgStable === true ? 1 : 0;
  return Number((history * decoder * unknown * costBasis * ordering * reorg).toFixed(6));
}

function recordBudgetUsage(db, entry) {
  ensureWalletCacheSchema(db);
  const costKind = entry.costKind;
  if (!['credit', 'cu', 'http'].includes(costKind)) throw new Error('invalid costKind');
  const units = entry.costUnits == null ? null : finiteNumber(entry.costUnits);
  if (entry.costUnits != null && (units == null || units < 0)) throw new Error('invalid costUnits');
  db.prepare(`
    INSERT INTO chain_budget_ledger(provider, endpoint, cost_units, cost_kind, task_id, entity_kind, entity_key, ts, metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(entry.provider, entry.endpoint, units, costKind, entry.taskId || null,
    entry.entityKind || null, entry.entityKey || null, entry.ts || Date.now(),
    entry.metadata ? JSON.stringify(entry.metadata) : null);
}

function recordHistoryCoverage(db, entry) {
  ensureWalletCacheSchema(db);
  const percent = entry.coveragePercent == null ? null : Number(entry.coveragePercent);
  if (percent != null && (!Number.isFinite(percent) || percent < 0 || percent > 1)) {
    throw new Error('coveragePercent must be in [0,1] or null');
  }
  db.prepare(`
    INSERT INTO chain_history_coverage
      (entity_kind, entity_key, source, coverage_start_slot, coverage_end_slot, events_count,
       expected_count, coverage_percent, status, decoder_coverage, gap_reason, checked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_kind, entity_key, source) DO UPDATE SET
      coverage_start_slot=excluded.coverage_start_slot, coverage_end_slot=excluded.coverage_end_slot,
      events_count=excluded.events_count, expected_count=excluded.expected_count,
      coverage_percent=excluded.coverage_percent, status=excluded.status,
      decoder_coverage=excluded.decoder_coverage, gap_reason=excluded.gap_reason,
      checked_at=excluded.checked_at
  `).run(entry.entityKind, entry.entityKey, entry.source, entry.coverageStartSlot ?? null,
    entry.coverageEndSlot ?? null, entry.eventsCount ?? 0, entry.expectedCount ?? null,
    percent, entry.status, entry.decoderCoverage || 'swap_only', entry.gapReason || null, entry.checkedAt || Date.now());
}

module.exports = {
  DECODER_VERSION,
  ensureWalletCacheSchema,
  cacheWalletTrades,
  markWalletHistory,
  walletHistoryFresh,
  authoritativePnlAllowed,
  calculateDataConfidence,
  recordBudgetUsage,
  recordHistoryCoverage
};
