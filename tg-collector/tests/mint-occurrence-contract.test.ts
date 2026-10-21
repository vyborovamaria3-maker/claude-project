import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { activeMintOccurrences } from "../src/analytics/token-candidate-occurrences.js";

// Never run this integration test against a development or production database.
const databaseUrl = process.env.TG_TEST_DATABASE_URL;
const isolated = Boolean(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));

test("active mint occurrences exclude deleted, unresolved and old evidence", {
  skip: !isolated,
}, async () => {
  const db = new Client({ connectionString: databaseUrl });
  const schema = "mint_evidence_" + randomUUID().replaceAll("-", "");
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}", public`);
    await db.query(`
      CREATE TABLE tg_sources (id bigint PRIMARY KEY, peer_id bigint);
      CREATE TABLE tg_messages (
        source_id bigint NOT NULL, message_id bigint NOT NULL,
        posted_at timestamptz, text text NOT NULL,
        edited_at timestamptz, deleted_at timestamptz,
        PRIMARY KEY (source_id, message_id)
      );
      CREATE TABLE tg_token_candidates (
        source_id bigint NOT NULL, message_id bigint NOT NULL,
        chain_id text NOT NULL, candidate_type text NOT NULL,
        candidate_key text NOT NULL, analysis_version integer NOT NULL,
        resolution_status text NOT NULL
      );
      CREATE TABLE tg_ticker_mentions (
        source_id bigint NOT NULL, message_id bigint NOT NULL,
        chain_id text NOT NULL, analysis_version integer NOT NULL,
        ticker text
      );
      INSERT INTO tg_sources VALUES (1, -100123), (2, -100456);
      INSERT INTO tg_messages(source_id,message_id,posted_at,text,edited_at,deleted_at) VALUES
        (1, 10, now(), 'live edited', now(), NULL),
        (1, 11, now(), 'deleted', NULL, now()),
        (1, 12, now(), 'unresolved', NULL, NULL),
        (2, 13, now(), 'old version', NULL, NULL),
        (2, 14, now(), 'different mint', NULL, NULL);
      INSERT INTO tg_token_candidates VALUES
        (1, 10, 'solana', 'address', 'mint-good', 7, 'confirmed_token'),
        (1, 11, 'solana', 'address', 'mint-good', 7, 'confirmed_token'),
        (1, 12, 'solana', 'address', 'mint-good', 7, 'pending'),
        (2, 13, 'solana', 'address', 'mint-good', 6, 'confirmed_token'),
        (2, 14, 'solana', 'address', 'mint-other', 7, 'confirmed_token');
      INSERT INTO tg_ticker_mentions VALUES (1, 10, 'solana', 7, 'GOOD');
    `);

    const result = await activeMintOccurrences(db as never, "mint-good", "solana", 7);
    assert.deepEqual(result.rows.map((row) => row.message_id), ["10"]);
    assert.equal(result.rows[0].text, "live edited");
    assert.equal(result.rows[0].peer_id, "-100123");
    assert.ok(result.rows[0].edited_at);
    assert.deepEqual(result.rows[0].tickers, ["GOOD"]);
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  }
});
