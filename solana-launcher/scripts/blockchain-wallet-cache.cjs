"use strict";

// Local-first, idempotent wallet-wide trade cache for the Solana seed collector.
// Raw Helius events remain the evidence layer; this module stores decoded swap legs
// and conservative summaries without asserting that an incomplete wallet history is complete.
const DECODER_VERSION = "wallet-trades-v1";

function ensureWalletCacheSchema(db) {
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
      last_error TEXT
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
      PRIMARY KEY(wallet, token_mint)
    );
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
      raw_event_kind, raw_event_address, first_seen_at, last_seen_at, status
    ) VALUES (
      @wallet, 'solana', @signature, @leg_key, @instruction_index, @slot, @block_time,
      'confirmed', @token_mint, @direction, @amount_tokens, @amount_sol,
      @fee_lamports, @dex, @pool, @counterparty, @decoder_version, @source_provider,
      'wallet', @wallet, @now, @now, 'ok'
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
      if (!swap) continue;
      const mints = new Set([...(swap.tokenInputs || []), ...(swap.tokenOutputs || [])]
        .map(leg => leg && leg.mint).filter(Boolean));
      for (const mint of mints) {
        if (typeof mint !== 'string') continue;
        const trades = txsToTrades([event], mint) || [];
        let legIndex = 0;
        for (const trade of trades) {
          if (!trade || !['buy','sell'].includes(String(trade.type).toLowerCase())) continue;
          // Only cache a trade when the decoder positively identifies this wallet as the trader.
          // Missing trader identity is ambiguous and must not contaminate wallet-level FIFO.
          if (!trade.trader || trade.trader !== wallet) continue;
          const direction = String(trade.type).toLowerCase();
          // Stable across replay; legIndex distinguishes multiple same-direction legs for a mint.
          const legKey = mint + ':' + direction + ':' + legIndex++;
          const result = insert.run({
            wallet,
            signature: trade.signature || event.signature,
            leg_key: legKey,
            instruction_index: finiteNumber(trade.instructionIndex),
            slot: finiteNumber(trade.slot ?? event.slot),
            block_time: finiteNumber(trade.timestamp ?? event.timestamp),
            token_mint: mint,
            direction,
            amount_tokens: trade.amountTokens == null ? null : String(trade.amountTokens),
            amount_sol: trade.amountSol == null ? null : String(trade.amountSol),
            fee_lamports: finiteNumber(trade.feeLamports),
            dex: trade.dex || (swap.programInfo && swap.programInfo.source) || null,
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
          (wallet, token_mint, trades_count, first_trade_at, last_trade_at, bought_amount, sold_amount, status, data_confidence)
        VALUES(?,?,?,?,?,?,?,'unknown',0)
        ON CONFLICT(wallet, token_mint) DO UPDATE SET
          trades_count=excluded.trades_count, first_trade_at=excluded.first_trade_at,
          last_trade_at=excluded.last_trade_at, bought_amount=excluded.bought_amount,
          sold_amount=excluded.sold_amount, status='unknown', data_confidence=0
      `).run(wallet, mint, rows.length, first, last, String(bought), String(sold));
      db.prepare(`
        INSERT INTO chain_wallet_token_touched(wallet, token_mint, last_trade_at, trade_count)
        VALUES(?,?,?,?)
        ON CONFLICT(wallet, token_mint) DO UPDATE SET
          last_trade_at=excluded.last_trade_at, trade_count=excluded.trade_count
      `).run(wallet, mint, last, rows.length);
    }
    db.prepare(`
      INSERT INTO chain_wallet_discovery
        (wallet, chain, first_discovered_at, history_status, tokens_touched, last_trade_at)
      VALUES(?, 'solana', ?, 'partial', ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        tokens_touched=MAX(chain_wallet_discovery.tokens_touched, excluded.tokens_touched),
        last_trade_at=MAX(COALESCE(chain_wallet_discovery.last_trade_at,0), COALESCE(excluded.last_trade_at,0))
    `).run(wallet, now, db.prepare('SELECT COUNT(*) AS n FROM chain_wallet_token_touched WHERE wallet=?').get(wallet).n,
      db.prepare('SELECT MAX(block_time) AS t FROM chain_wallet_trades WHERE wallet=?').get(wallet).t);
  });
  tx();
  return { upserted: insertedOrUpdated, tokenMints: [...tokenMints] };
}

function markWalletHistory(db, wallet, state) {
  ensureWalletCacheSchema(db);
  const now = state.now ?? Date.now();
  const complete = Boolean(state.complete && !state.forwardCursor && !state.possibleGap);
  db.prepare(`
    INSERT INTO chain_wallet_discovery
      (wallet, chain, first_discovered_at, history_status, last_fetched_at, backfill_cursor,
       forward_cursor, backfill_complete, possible_gap, tokens_touched, last_trade_at, last_error)
    VALUES(?, 'solana', ?, ?, ?, ?, ?, ?, ?, 
      (SELECT COUNT(*) FROM chain_wallet_token_touched WHERE wallet=?),
      (SELECT MAX(block_time) FROM chain_wallet_trades WHERE wallet=?), ?)
    ON CONFLICT(wallet) DO UPDATE SET
      history_status=excluded.history_status, last_fetched_at=excluded.last_fetched_at,
      backfill_cursor=excluded.backfill_cursor, forward_cursor=excluded.forward_cursor,
      backfill_complete=excluded.backfill_complete, possible_gap=excluded.possible_gap,
      tokens_touched=excluded.tokens_touched, last_trade_at=excluded.last_trade_at,
      last_error=excluded.last_error
  `).run(wallet, now, complete ? 'complete' : 'partial', now, state.backfillCursor || null,
    state.forwardCursor || null, complete ? 1 : 0, state.possibleGap ? 1 : 0, wallet, wallet, null);
}

function walletHistoryFresh(db, wallet, now = Date.now()) {
  ensureWalletCacheSchema(db);
  const row = db.prepare(`
    SELECT history_status, last_fetched_at, last_trade_at FROM chain_wallet_discovery WHERE wallet=?
  `).get(wallet);
  if (!row || row.history_status !== 'complete' || row.last_fetched_at == null) return false;
  const active = row.last_trade_at != null && row.last_trade_at >= Math.floor((now - 24 * 3600_000) / 1000);
  const threshold = active ? 2 * 3600_000 : 24 * 3600_000;
  return now - row.last_fetched_at < threshold;
}

module.exports = {
  DECODER_VERSION,
  ensureWalletCacheSchema,
  cacheWalletTrades,
  markWalletHistory,
  walletHistoryFresh
};
