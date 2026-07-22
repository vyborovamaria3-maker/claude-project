const Database = require('better-sqlite3');
const path = require('path');

const SRC = process.argv[2] || 'C:\\Users\\Рафаил\\claude-project\\data\\trade.db';
const DST = process.argv[3] || path.resolve(__dirname, '..', 'data', 'trade.db');

console.log('Merging tokens from:');
console.log('  SRC:', SRC);
console.log('  DST:', DST);

const db = new Database(DST);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

// Make sure migration tables exist on destination — they will, since lib/trade/db.ts init created them.
// We connect via the standard codepath for safety.
db.exec(`ATTACH DATABASE '${SRC.replace(/'/g, "''")}' AS src`);

const before = {
  files: db.prepare('SELECT COUNT(*) AS n FROM migration_xlsx_files').get().n,
  tokens: db.prepare('SELECT COUNT(*) AS n FROM migration_token_rows').get().n,
  uniqTokens: db.prepare('SELECT COUNT(DISTINCT token_address) AS n FROM migration_token_rows').get().n,
  wallets: db.prepare('SELECT COUNT(*) AS n FROM migration_wallet_rows').get().n,
};
console.log('\nDST before:', before);

const srcStats = {
  files: db.prepare('SELECT COUNT(*) AS n FROM src.migration_xlsx_files').get().n,
  tokens: db.prepare('SELECT COUNT(*) AS n FROM src.migration_token_rows').get().n,
  uniqTokens: db.prepare('SELECT COUNT(DISTINCT token_address) AS n FROM src.migration_token_rows').get().n,
  wallets: db.prepare('SELECT COUNT(*) AS n FROM src.migration_wallet_rows').get().n,
};
console.log('SRC has:    ', srcStats);

const tx = db.transaction(() => {
  // migration_xlsx_files: PK is file_path
  db.exec(`
    INSERT OR IGNORE INTO migration_xlsx_files
    SELECT * FROM src.migration_xlsx_files
  `);
  // migration_token_rows: id is autoincrement, must NOT copy id; UNIQUE(file_path, sheet_name, row_index)
  db.exec(`
    INSERT OR IGNORE INTO migration_token_rows (
      file_path, file_name, sheet_name, row_index,
      token_address, ticker, total_unique_buyers, current_mc, market_cap_max,
      mint_time_text, migration_time_text, time_before_migration_text, time_before_migration_seconds,
      creator, creator_source, raw_json, imported_at
    )
    SELECT
      file_path, file_name, sheet_name, row_index,
      token_address, ticker, total_unique_buyers, current_mc, market_cap_max,
      mint_time_text, migration_time_text, time_before_migration_text, time_before_migration_seconds,
      creator, creator_source, raw_json, imported_at
    FROM src.migration_token_rows
  `);
  // migration_wallet_rows
  db.exec(`
    INSERT OR IGNORE INTO migration_wallet_rows (
      file_path, file_name, sheet_name, row_index,
      wallet, wr, roi, pnl, rockets, median_roi, avg_roi,
      fast_trades, fast_trades_pct, balance, total_tokens,
      sold_gt_bought, sold_gt_bought_pct, avg_trade_duration_text,
      pf_tokens, pf_trades_pct, avg_buy_sol, median_sol_buy,
      avg_mcap_first_tx, avg_mcap_last_tx, last_trade_text, last_trade_hour,
      migrated_tokens, migrated_pct, raw_json, imported_at
    )
    SELECT
      file_path, file_name, sheet_name, row_index,
      wallet, wr, roi, pnl, rockets, median_roi, avg_roi,
      fast_trades, fast_trades_pct, balance, total_tokens,
      sold_gt_bought, sold_gt_bought_pct, avg_trade_duration_text,
      pf_tokens, pf_trades_pct, avg_buy_sol, median_sol_buy,
      avg_mcap_first_tx, avg_mcap_last_tx, last_trade_text, last_trade_hour,
      migrated_tokens, migrated_pct, raw_json, imported_at
    FROM src.migration_wallet_rows
  `);
});

console.log('\nMerging…');
tx();

const after = {
  files: db.prepare('SELECT COUNT(*) AS n FROM migration_xlsx_files').get().n,
  tokens: db.prepare('SELECT COUNT(*) AS n FROM migration_token_rows').get().n,
  uniqTokens: db.prepare('SELECT COUNT(DISTINCT token_address) AS n FROM migration_token_rows').get().n,
  wallets: db.prepare('SELECT COUNT(*) AS n FROM migration_wallet_rows').get().n,
};
console.log('\nDST after: ', after);
console.log('\nAdded tokens (rows):', after.tokens - before.tokens);
console.log('Added unique tokens:', after.uniqTokens - before.uniqTokens);
console.log('Added wallets (rows):', after.wallets - before.wallets);
console.log('Added xlsx files:', after.files - before.files);

db.exec('DETACH DATABASE src');
db.close();
console.log('\n✅ Merge complete.');
