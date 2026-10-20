import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Database from "better-sqlite3";
import {
  buildEntityRef, buildEvidenceRef, buildTimelineEvent,
  formatAuthorId, formatSourceId, formatWalletId, formatTokenId,
} from "@claude-project/contracts";
import {
  POSTGRES_OUTBOX_DDL, SQLITE_OUTBOX_DDL,
  emitPostgres, claimPostgres, ackPostgres, failPostgres,
  emitSqlite, claimSqlite, ackSqlite, failSqlite,
} from "@claude-project/event-outbox";
import { runDeliveryBatch, queryTokenTimeline } from "../dist/index.js";

const url = process.env.INTELLIGENCE_TEST_DB_URL;
const token = formatTokenId("solana", "So11111111111111111111111111111111111111112");
const occurred = ["2026-10-18T01:00:00Z", "2026-10-18T01:02:00Z", "2026-10-18T01:03:00Z"];
const observed = ["2026-10-18T01:05:00Z", "2026-10-18T01:20:00Z", "2026-10-18T01:04:00Z"];

function sourceEvent(sourceSystem, eventKind, eventKey, kind, otherRef, evidenceRef, index) {
  // The token link here is synthetic and intentionally pre-validated.
  // Real X/TG/Blockchain producers do NOT yet emit these token links:
  // a separate evidence-based token resolver is required before live rollout.
  const tokenRef = buildEntityRef({
    kind: "token", canonicalId: token,
    firstSeenAt: observed[index], lastSeenAt: observed[index],
  });
  const entityRefs = [otherRef, tokenRef];
  const registryEvent = {
    sourceSystem, eventKind, eventKey, schemaVersion: "fixture-v1",
    entityRefs, evidenceRef,
  };
  const timelineEvent = buildTimelineEvent({
    eventKey, kind, entityRefs, evidenceRef,
    occurredAt: occurred[index], observedAt: observed[index],
    payload: { synthetic: true },
  });
  return {
    sourceSystem, eventKind, eventKey, schemaVersion: "fixture-v1",
    payload: { registryEvent, timelineEvent },
  };
}

function pgPort(pool) {
  return {
    claim: options => claimPostgres(pool, options),
    ack: event => ackPostgres(pool, event.id, event.leaseOwner, event.leaseUntil),
    fail: (event, reason, next) =>
      failPostgres(pool, event.id, event.leaseOwner, event.leaseUntil, reason, next),
  };
}

function sqlitePort(db) {
  return {
    claim: async options => claimSqlite(db, options),
    ack: async event => ackSqlite(db, event.id, event.leaseOwner, event.leaseUntil),
    fail: async (event, reason, next) =>
      failSqlite(db, event.id, event.leaseOwner, event.leaseUntil, reason, next),
  };
}

async function deliver(source, destination, workerId) {
  return runDeliveryBatch(source, destination, {
    workerId, batchSize: 3, leaseMs: 120_000,
  });
}

test("three isolated source outboxes produce one evidence-backed token timeline with as-of boundaries and idempotent replay", {
  skip: !url,
}, async () => {
  const suffix = randomBytes(6).toString("hex");
  const schemas = {
    x: "x_source_" + suffix,
    tg: "tg_source_" + suffix,
    dst: "intelligence_" + suffix,
  };
  const admin = new pg.Client({ connectionString: url });
  let xPool, tgPool, destination, sqlite;
  await admin.connect();
  try {
    for (const schema of Object.values(schemas)) {
      await admin.query('CREATE SCHEMA "' + schema + '"');
    }
    for (const source of ["x", "tg"]) {
      await admin.query('SET search_path TO "' + schemas[source] + '"');
      await admin.query(POSTGRES_OUTBOX_DDL);
    }
    await admin.query('SET search_path TO "' + schemas.dst + '"');
    for (const name of ["001_entity_registry.sql", "002_timeline.sql"]) {
      await admin.query(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
    }
    const poolFor = schema => new pg.Pool({
      connectionString: url, options: "-c search_path=" + schema, max: 3,
    });
    xPool = poolFor(schemas.x);
    tgPool = poolFor(schemas.tg);
    destination = poolFor(schemas.dst);
    for (const [pool, name] of [
      [xPool, schemas.x], [tgPool, schemas.tg], [destination, schemas.dst],
    ]) {
      assert.equal((await pool.query("SELECT current_schema() AS schema")).rows[0].schema, name);
    }

    const refs = [
      buildEntityRef({
        kind: "author", canonicalId: formatAuthorId("x", "9999"),
        firstSeenAt: observed[0], lastSeenAt: observed[0],
      }),
      buildEntityRef({
        kind: "source", canonicalId: formatSourceId("tg", "12345"),
        firstSeenAt: observed[1], lastSeenAt: observed[1],
      }),
      buildEntityRef({
        kind: "wallet", canonicalId: formatWalletId("solana", "1".repeat(32)),
        firstSeenAt: observed[2], lastSeenAt: observed[2],
      }),
    ];
    const evidence = [
      buildEvidenceRef({
        sourceKind: "x_tweet", tweetId: "101",
        occurredAt: occurred[0], observedAt: observed[0],
      }),
      buildEvidenceRef({
        sourceKind: "tg_message", sourceAccountId: "12345", messageId: "201",
        occurredAt: occurred[1], observedAt: observed[1],
      }),
      buildEvidenceRef({
        sourceKind: "chain_tx", chain: "solana",
        transactionId: "1".repeat(64),
        occurredAt: occurred[2], observedAt: observed[2],
      }),
    ];
    const events = [
      sourceEvent("x", "tweet_observed", "x:tweet:101:observed:1",
        "tweet_published", refs[0], evidence[0], 0),
      sourceEvent("tg", "message_observed", "tg:12345:201:rev:1",
        "tg_message_published", refs[1], evidence[1], 1),
      sourceEvent("blockchain", "wallet_transaction_observed",
        "chain:wallet:fixture:signature:fixture:hash:1",
        "chain_transaction", refs[2], evidence[2], 2),
    ];

    for (const [pool, event] of [[xPool, events[0]], [tgPool, events[1]]]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await emitPostgres(client, event);
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* retain first cause */ }
        throw error;
      } finally { client.release(); }
    }
    sqlite = new Database(":memory:");
    sqlite.exec(SQLITE_OUTBOX_DDL);
    sqlite.transaction(() => emitSqlite(sqlite, events[2]))();

    const sources = [pgPort(xPool), pgPort(tgPool), sqlitePort(sqlite)];
    for (const [index, source] of sources.entries()) {
      const result = await deliver(source, destination, "first-" + index);
      assert.deepEqual(result, {
        claimed: 1, delivered: 1, duplicates: 0, failed: 0, lostLeases: 0,
      });
    }

    const all = await queryTokenTimeline(
      destination, token, "2026-10-18T01:10:00Z", "2026-10-18T01:30:00Z",
    );
    assert.deepEqual(new Set(all.map(event => event.source_system)),
      new Set(["x", "tg", "blockchain"]));
    assert.equal(all.length, 3);
    assert.deepEqual(new Set(all.map(event => event.evidence_source_id)),
      new Set(evidence.map(item => item.sourceId)));

    const knownAtTen = await queryTokenTimeline(
      destination, token, "2026-10-18T01:10:00Z", "2026-10-18T01:10:00Z",
    );
    assert.deepEqual(new Set(knownAtTen.map(event => event.source_system)),
      new Set(["x", "blockchain"]), "late-observed Telegram event must not leak into earlier as-of view");
    assert.equal((await queryTokenTimeline(
      destination, token, "2026-10-18T01:01:00Z", "2026-10-18T01:30:00Z",
    )).length, 1, "occurredAt cutoff must be independent of observation time");

    assert.equal((await queryTokenTimeline(
      destination, formatTokenId("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      "2026-10-18T01:10:00Z", "2026-10-18T01:30:00Z",
    )).length, 0, "a different mint must not inherit events");

    assert.equal((await tgPool.query(
      "SELECT count(*)::integer AS n FROM outbox_events WHERE processed_at IS NOT NULL",
    )).rows[0].n, 1);
    assert.equal((await xPool.query(
      "SELECT count(*)::integer AS n FROM outbox_events WHERE processed_at IS NOT NULL",
    )).rows[0].n, 1);
    assert.equal(sqlite.prepare(
      "SELECT count(*) AS n FROM outbox_events WHERE processed_at IS NOT NULL",
    ).get().n, 1);

    // Simulate a lost ACK after destination COMMIT for every independent source.
    for (const pool of [xPool, tgPool]) {
      await pool.query("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL");
    }
    sqlite.prepare(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL",
    ).run();
    for (const [index, source] of sources.entries()) {
      const replay = await deliver(source, destination, "replay-" + index);
      assert.deepEqual(replay, {
        claimed: 1, delivered: 0, duplicates: 1, failed: 0, lostLeases: 0,
      });
    }
    for (const table of ["intelligence_inbox", "entity_evidence", "timeline_events"]) {
      const count = await destination.query('SELECT count(*)::integer AS n FROM "' + table + '"');
      assert.equal(count.rows[0].n, 3, table + " must remain idempotent");
    }
    assert.equal((await queryTokenTimeline(
      destination, token, "2026-10-18T01:10:00Z", "2026-10-18T01:30:00Z",
    )).length, 3);
  } finally {
    if (sqlite) sqlite.close();
    if (xPool) await xPool.end();
    if (tgPool) await tgPool.end();
    if (destination) await destination.end();
    for (const schema of Object.values(schemas).reverse()) {
      try { await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); }
      catch { /* preserve original test failure */ }
    }
    await admin.end();
  }
});
