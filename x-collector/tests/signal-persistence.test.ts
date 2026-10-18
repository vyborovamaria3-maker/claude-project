import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { closePool } from "../lib/trade/pg";
import { buildSignal, saveSignals } from "../src/intelligence/signals/detector";
import { SIGNAL_CONFIG } from "../src/intelligence/signals/config";

test("signal batches bind values, update idempotently and isolate versions", async () => {
  const db = new PGlite();
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://offline:offline@localhost/offline";
  const query = mock.method(Pool.prototype, "query", async (sql: string, values: unknown[]) => {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.affectedRows };
  });
  try {
    await db.exec(`CREATE TABLE signal_history (
      source TEXT, signal_version INTEGER DEFAULT 1, mint TEXT, signal_at BIGINT,
      score DOUBLE PRECISION, level TEXT, details JSONB,
      PRIMARY KEY(source, signal_version, mint, signal_at)
    )`);
    const signals = ["mint'one", "mint-two"].map(value => buildSignal({
      entityType: "TOKEN", value, currentMentions: 8, previousMentions: 4,
      uniqueAuthors: 5, firstSeen: 1,
    }, { hours: 6, now: 1000, minScore: 0, config: SIGNAL_CONFIG }));
    assert.equal(await saveSignals(signals, { source: "entity", signalAt: 1000 }), 2);
    const updated = signals.map(signal => ({ ...signal, score: 91 }));
    assert.equal(await saveSignals(updated, { source: "entity", signalAt: 1000 }), 2);
    assert.equal(await saveSignals(signals, { source: "entity", signalAt: 1000, signalVersion: 2 }), 2);
    const result = await db.query<{ signal_version: number; score: number; mint: string }>(
      "SELECT signal_version, score, mint FROM signal_history ORDER BY signal_version, mint",
    );
    assert.equal(result.rows.length, 4);
    assert.equal(result.rows[0].mint, "mint'one");
    assert.deepEqual(result.rows.map(row => row.signal_version), [1, 1, 2, 2]);
    assert.deepEqual(result.rows.slice(0, 2).map(row => row.score), [91, 91]);
    assert.deepEqual(result.rows.slice(2).map(row => row.score), signals.map(signal => signal.score));
  } finally {
    query.mock.restore();
    await closePool();
    await db.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});
