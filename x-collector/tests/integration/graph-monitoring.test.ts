import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { executeMonitoringCycle } from "../../lib/trade/graph-monitoring";

test("PostgreSQL: real writes, deduplication, lock contention and rollback", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const second = await pool.connect();
  const schema = `graph_test_${Date.now()}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE twitter_tweets(tweet_id text PRIMARY KEY,handle text,posted_at bigint);
      CREATE TABLE tweet_entities(tweet_id text,entity_type text,value text,confidence numeric);
      CREATE TABLE tweet_token_links(tweet_id text,mint text);
      CREATE TABLE author_reputation(handle text PRIMARY KEY,reputation_score numeric);`);
    await client.query(await fs.readFile(path.resolve("migrations/012_graph_monitoring.sql"), "utf8"));
    for (let i=0;i<20;i++) {
      await client.query("INSERT INTO twitter_tweets VALUES($1,$1,9500)",[String(i)]);
      await client.query("INSERT INTO tweet_token_links VALUES($1,'mint-a')",[String(i)]);
      await client.query("INSERT INTO author_reputation VALUES($1,100)",[String(i)]);
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const first = await executeMonitoringCycle(client,10500,1000);
    assert.equal(first.signals,1); assert.equal(first.events,1);
    await second.query("BEGIN");
    assert.equal((await executeMonitoringCycle(second,10500,1000)).acquired,false);
    await second.query("ROLLBACK");
    await client.query("COMMIT");
    await client.query("BEGIN");
    const retry=await executeMonitoringCycle(client,10900,1000);
    assert.equal(retry.signals,0); assert.equal(retry.events,0);
    await client.query("COMMIT");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM graph_signal_history")).rows[0].n,1);
    await client.query("BEGIN");
    await executeMonitoringCycle(client,10500,500);
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM graph_signal_history")).rows[0].n,1);
  } finally {
    await client.query("ROLLBACK").catch(()=>{});
    await second.query("ROLLBACK").catch(()=>{});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release(); second.release(); await pool.end();
  }
});
