import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { REQUIRED } from "../lib/trade/migrations";
import { link, recordRaw, resolveEntity } from "../lib/trade/intelligence-store";
import { AuditError, listAudit, recordAudit } from "../lib/intelligence/audit-log";
import { checkIntelligenceHealth } from "../lib/intelligence/intelligence-health";
import { RetentionError, applyIntelligenceRetention } from "../lib/intelligence/retention";

const load = createRequire(__filename);
const { pg_trgm } = load("@electric-sql/pglite/contrib/pg_trgm") as { pg_trgm: import("@electric-sql/pglite").Extension };

function fixture() {
  const db = new PGlite({ extensions: { pg_trgm } });
  const c = { query: (sql: string, args: unknown[] = []) => db.query(sql, args) } as unknown as Pick<PoolClient, "query">;
  return { db, c };
}

async function fullChain(db: PGlite) {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  for (const name of REQUIRED) {
    await db.exec(await fs.readFile("migrations/" + name, "utf8"));
    await db.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [name]);
  }
}

test("hardening: health reports real checks and degrades on queue pressure", async () => {
  const { db, c } = fixture();
  try {
    await fullChain(db);

    const empty = await checkIntelligenceHealth(c);
    assert.equal(empty.status, "healthy");
    assert.equal(empty.checks.length, 6);
    assert.ok(empty.checks.every((check) => check.ok));
    assert.equal(empty.counts.unsourced_relations, 0);
    assert.equal(empty.counts.entities, 0);

    const subject = await resolveEntity(c, "ACCOUNT", "X", "health-handle", "@health");
    const raw = await recordRaw(c, "TWEET", "health-tweet", { text: "pending" }, new Date("2026-10-10T00:00:00Z"), null);
    await link(c, subject, subject, "SHARED", raw, new Date("2026-10-10T00:00:00Z"), 1);

    const withData = await checkIntelligenceHealth(c);
    assert.equal(withData.status, "healthy");
    assert.equal(withData.counts.entities, 1);
    assert.equal(withData.counts.pending_normalizations, 1);
    assert.equal(withData.counts.relations, 1);

    const pressured = await checkIntelligenceHealth(c, { pendingNormalization: 0, pendingAgeHours: 0, openInvestigations: 0 });
    assert.equal(pressured.status, "degraded");
    assert.ok(pressured.checks.some((check) => check.name === "normalization_queue" && !check.ok));
  } finally {
    await db.close();
  }
});

test("hardening: health reports unavailable when required migrations are missing", async () => {
  const { db, c } = fixture();
  try {
    for (const name of ["023_intelligence_platform.sql", "024_intelligence_temporal.sql", "036_investigations.sql", "037_intelligence_audit.sql"]) {
      await db.exec(await fs.readFile("migrations/" + name, "utf8"));
    }
    const health = await checkIntelligenceHealth(c);
    assert.equal(health.status, "degraded");
    const migrations = health.checks.find((check) => check.name === "migrations");
    assert.ok(migrations && !migrations.ok);
    assert.equal(health.checks.find((check) => check.name === "tables")?.ok, true);
  } finally {
    await db.close();
  }
});

test("hardening: audit log is append-only, validated and filterable", async () => {
  const { db, c } = fixture();
  try {
    await fullChain(db);
    const subject = await resolveEntity(c, "ACCOUNT", "X", "audit-handle", "@audit");

    await assert.rejects(recordAudit(c, { action: "" }), AuditError);
    await assert.rejects(recordAudit(c, { action: "x".repeat(101) }), AuditError);
    await assert.rejects(recordAudit(c, { action: "test", entityId: randomUUID() }), AuditError);
    await assert.rejects(recordAudit(c, { action: "test", payload: [] as never }), AuditError);

    const first = await recordAudit(c, { action: "test.open", actor: "tester", entityId: subject, payload: { n: 1 } });
    assert.equal(first.actor, "tester");
    assert.equal(first.action, "test.open");
    assert.equal(first.entity_id, subject);
    assert.deepEqual(first.payload, { n: 1 });

    await recordAudit(c, { action: "test.close", payload: {} });
    const all = await listAudit(c);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((entry) => entry.action).sort(), ["test.close", "test.open"]);

    const filtered = await listAudit(c, { action: "test.open", entityId: subject });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, first.id);

    const future = await listAudit(c, { since: new Date("2099-01-01T00:00:00Z") });
    assert.equal(future.length, 0);
    await assert.rejects(listAudit(c, { limit: 0 }), AuditError);
    await assert.rejects(listAudit(c, { offset: -1 }), AuditError);
    await assert.rejects(listAudit(c, { entityId: "not-a-uuid" }), AuditError);
    await assert.rejects(listAudit(c, { since: new Date("nope") }), AuditError);
  } finally {
    await db.close();
  }
});

test("hardening: retention deletes only expired snapshots and never evidence", async () => {
  const { db, c } = fixture();
  try {
    await fullChain(db);
    const subject = await resolveEntity(c, "ACCOUNT", "X", "retention-handle", "@retention");
    const raw = await recordRaw(c, "TWEET", "retention-tweet", { text: "kept" }, new Date("2026-10-10T00:00:00Z"), null);
    await link(c, subject, subject, "SHARED", raw, new Date("2026-10-10T00:00:00Z"), 1);

    const insert = async (id: string, observedAt: string) => {
      const event = randomUUID();
      await db.query(
        `INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collected_at)
         VALUES($1,'X','TWEET',$2,$3::jsonb,$4,now())`,
        [event, "event-" + event, JSON.stringify({ snapshot: id }), "hash-" + event],
      );
      await db.query(
        `INSERT INTO ip_entity_snapshots(id,entity_id,raw_event_id,observed_at,payload) VALUES($1,$2,$3,$4::timestamptz,$5::jsonb)`,
        [id, subject, event, observedAt, JSON.stringify({ old: true })],
      );
    };
    const staleA = randomUUID(), staleB = randomUUID(), fresh = randomUUID();
    await insert(staleA, "2020-01-01T00:00:00Z");
    await insert(staleB, "2020-01-02T00:00:00Z");
    await insert(fresh, new Date().toISOString());

    await assert.rejects(applyIntelligenceRetention(c, { snapshotDays: 0 }), RetentionError);
    await assert.rejects(applyIntelligenceRetention(c, { batchSize: 0 }), RetentionError);
    await assert.rejects(applyIntelligenceRetention(c, { snapshotDays: 5000 }), RetentionError);
    await assert.rejects(applyIntelligenceRetention(c, { batchSize: 99999 }), RetentionError);

    const evidenceBefore = (await db.query<{ count: string }>("SELECT count(*)::text count FROM ip_relation_evidence")).rows[0].count;
    const dry = await applyIntelligenceRetention(c, { snapshotDays: 365, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.snapshots, 2);
    assert.equal((await db.query<{ count: string }>("SELECT count(*)::text count FROM ip_entity_snapshots")).rows[0].count, "3");

    const single = await applyIntelligenceRetention(c, { snapshotDays: 365, batchSize: 1 });
    assert.equal(single.snapshots, 1);
    assert.equal(single.protectedTables.includes("ip_raw_events"), true);

    const rest = await applyIntelligenceRetention(c, { snapshotDays: 365 });
    assert.equal(rest.snapshots, 1);
    const left = (await db.query<{ id: string }>("SELECT id FROM ip_entity_snapshots")).rows.map((row) => row.id);
    assert.deepEqual(left, [fresh]);

    assert.equal((await db.query<{ count: string }>("SELECT count(*)::text count FROM ip_raw_events")).rows[0].count, "4");
    assert.equal((await db.query<{ count: string }>("SELECT count(*)::text count FROM ip_entity_relations")).rows[0].count, "1");
    const evidenceAfter = (await db.query<{ count: string }>("SELECT count(*)::text count FROM ip_relation_evidence")).rows[0].count;
    assert.equal(evidenceAfter, evidenceBefore);
  } finally {
    await db.close();
  }
});

test("hardening: investigation lifecycle writes audit entries", async () => {
  const { db, c } = fixture();
  try {
    await fullChain(db);
    const { openInvestigation, appendStep, closeInvestigation } = await import("../lib/intelligence/investigation-runner");
    const subject = await resolveEntity(c, "ACCOUNT", "X", "wired-audit", "@wired");
    const investigation = await openInvestigation(c, { title: "audited", subjectEntityId: subject, createdBy: "auditor" });
    await appendStep(c, investigation.id, { kind: "OBSERVATION", content: "seen", entityId: subject });
    await closeInvestigation(c, investigation.id, "done");

    const actions = (await listAudit(c, { entityId: subject })).map((entry) => entry.action).sort();
    assert.deepEqual(actions, ["investigation.close", "investigation.open", "investigation.step"]);
    const opened = (await listAudit(c, { action: "investigation.open" }))[0];
    assert.equal(opened.actor, "auditor");
    assert.equal(opened.entity_id, subject);
  } finally {
    await db.close();
  }
});
