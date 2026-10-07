import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load = createRequire(__filename);
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const { pg_trgm } = load('@electric-sql/pglite/contrib/pg_trgm') as { pg_trgm: import('@electric-sql/pglite').Extension };

test('001–014 migration chain executes on disposable PostgreSQL engine', async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  try {
    const files = (await fs.readdir('migrations')).filter(f => f.endsWith('.sql')).sort();
    assert.equal(files.length, 14);
    for (const file of files) {
      try { await db.exec(await fs.readFile('migrations/' + file, 'utf8')); }
      catch (error) { throw new Error(file + ': ' + String(error), { cause: error }); }
    }
    const indexes = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_tweets_first_seen','idx_ttl_linked_at','idx_x_tasks_terminal_created','idx_runs_terminal_started')");
    assert.equal(indexes.rows.length, 4);
    // Reconstructed 003 is additive and safe to replay.
    await db.exec(await fs.readFile('migrations/003_performance.sql', 'utf8'));
    await db.query('SELECT * FROM daily_digest(CURRENT_DATE)');
    for (const view of ['v_mint_summary', 'v_mint_daily_funnel', 'v_mint_bursts', 'v_top_tweets', 'mv_shillers', 'v_cashtag_trends', 'v_worker_efficiency', 'v_account_health', 'v_early_signals', 'v_lead_authors']) {
      await db.query('SELECT * FROM ' + view + ' LIMIT 1');
    }
    for (const fn of ['rebuild_hype_scores()', 'rebuild_ultra_scores()', 'capture_mint_attention_snapshots()', 'capture_signal_history()', 'apply_retention(true)']) {
      await db.query('SELECT * FROM ' + fn);
    }
  } finally { await db.close(); }
});
