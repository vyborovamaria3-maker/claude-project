import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { link, recordRaw, resolveEntity } from "../lib/trade/intelligence-store";
import {
  InvestigationError,
  appendStep,
  closeInvestigation,
  getInvestigation,
  listInvestigations,
  openInvestigation,
  runInvestigation,
} from "../lib/intelligence/investigation-runner";

function fixture() {
  const db = new PGlite();
  const c = { query: (sql: string, args: unknown[] = []) => db.query(sql, args) } as unknown as Pick<PoolClient, "query">;
  return { db, c };
}

async function migrations(db: PGlite) {
  for (const name of ["023_intelligence_platform.sql", "024_intelligence_temporal.sql", "036_investigations.sql", "037_intelligence_audit.sql"]) {
    await db.exec(await fs.readFile("migrations/" + name, "utf8"));
  }
}

test("investigation: open, append, close lifecycle is state-safe", async () => {
  const { db, c } = fixture();
  try {
    await migrations(db);
    const subject = await resolveEntity(c, "ACCOUNT", "X", "subject-handle", "@subject");
    const investigation = await openInvestigation(c, { title: "  Wallet cluster  ", subjectEntityId: subject, hypothesis: "shared funding" });
    assert.equal(investigation.status, "OPEN");
    assert.equal(investigation.title, "Wallet cluster");
    assert.equal(investigation.created_by, "agent");

    await assert.rejects(openInvestigation(c, { title: "   " }), InvestigationError);
    await assert.rejects(openInvestigation(c, { title: "x".repeat(301) }), InvestigationError);
    await assert.rejects(openInvestigation(c, { title: "t", subjectEntityId: randomUUID() }), InvestigationError);
    await assert.rejects(openInvestigation(c, { title: "t", priority: "HIGH" as never }), InvestigationError);

    const step = await appendStep(c, investigation.id, { kind: "OBSERVATION", content: "profile exists", entityId: subject });
    assert.equal(step.kind, "OBSERVATION");
    assert.equal(step.entity_id, subject);
    const active = await getInvestigation(c, investigation.id);
    assert.equal(active.investigation.status, "ACTIVE");
    assert.ok(active.investigation.started_at);

    await assert.rejects(appendStep(c, investigation.id, { kind: "EVIDENCE", content: "no event" }), InvestigationError);
    await assert.rejects(appendStep(c, investigation.id, { kind: "NOT_A_KIND" as never, content: "x" }), InvestigationError);
    await assert.rejects(appendStep(c, investigation.id, { kind: "TASK", content: "" }), InvestigationError);
    await assert.rejects(appendStep(c, investigation.id, { kind: "TASK", content: "x", confidence: 2 }), InvestigationError);
    await assert.rejects(appendStep(c, randomUUID(), { kind: "TASK", content: "x" }), InvestigationError);

    const closed = await closeInvestigation(c, investigation.id, "  enough observed  ");
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.summary, "enough observed");
    assert.ok(closed.closed_at);
    await assert.rejects(appendStep(c, investigation.id, { kind: "TASK", content: "late" }), InvestigationError);
    await assert.rejects(closeInvestigation(c, investigation.id, "again"), InvestigationError);
    await assert.rejects(closeInvestigation(c, investigation.id, "   "), InvestigationError);
    await assert.rejects(getInvestigation(c, randomUUID()), InvestigationError);
  } finally {
    await db.close();
  }
});

test("investigation: EVIDENCE steps only accept existing raw events", async () => {
  const { db, c } = fixture();
  try {
    await migrations(db);
    const subject = await resolveEntity(c, "ACCOUNT", "X", "evidence-handle", "@evidence");
    const rawId = await recordRaw(c, "TWEET", "tweet-1", { text: "observed" }, new Date("2026-10-10T00:00:00Z"), null);
    const investigation = await openInvestigation(c, { title: "Evidence", subjectEntityId: subject });
    const step = await appendStep(c, investigation.id, { kind: "EVIDENCE", content: "tweet-1", sourceEventId: rawId });
    assert.equal(step.source_event_id, rawId);
    await assert.rejects(
      appendStep(c, investigation.id, { kind: "EVIDENCE", content: "ghost", sourceEventId: randomUUID() }),
      InvestigationError,
    );
  } finally {
    await db.close();
  }
});

test("investigation: list filters by status and subject without inventing links", async () => {
  const { db, c } = fixture();
  try {
    await migrations(db);
    const subject = await resolveEntity(c, "ACCOUNT", "X", "list-handle", "@list");
    const open = await openInvestigation(c, { title: "open one", subjectEntityId: subject });
    const closed = await openInvestigation(c, { title: "closed one", subjectEntityId: subject });
    await closeInvestigation(c, closed.id, "done");

    const openRows = await listInvestigations(c, { status: "OPEN" });
    assert.equal(openRows.length, 1);
    assert.equal(openRows[0].id, open.id);
    const closedRows = await listInvestigations(c, { status: "CLOSED", subjectEntityId: subject });
    assert.equal(closedRows.length, 1);
    assert.equal(closedRows[0].id, closed.id);
    await assert.rejects(listInvestigations(c, { status: "NOPE" as never }), InvestigationError);
    await assert.rejects(listInvestigations(c, { subjectEntityId: randomUUID() }), InvestigationError);
    await assert.rejects(listInvestigations(c, { limit: 0 }), InvestigationError);
    await assert.rejects(listInvestigations(c, { subjectEntityId: randomUUID().replace(/f/g, "0") }), InvestigationError);
  } finally {
    await db.close();
  }
});

test("investigation: runInvestigation is deterministic and evidence-first", async () => {
  const { db, c } = fixture();
  try {
    await migrations(db);
    const first = await resolveEntity(c, "ACCOUNT", "X", "alpha", "@alpha");
    const second = await resolveEntity(c, "ACCOUNT", "X", "beta", "@beta");
    const events: string[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(await recordRaw(c, "TWEET", `tweet-${i}`, { text: `hello ${i}` }, new Date(Date.UTC(2026, 9, 10, i)), null));
    }
    await link(c, first, second, "SHARED", events[0], new Date("2026-10-10T00:00:00Z"), 0.9);
    await link(c, second, first, "MENTION", events[1], new Date("2026-10-10T01:00:00Z"), 0.8);

    const relationsBefore = (await db.query<{ count: string }>(`SELECT count(*)::text count FROM ip_entity_relations`)).rows[0].count;

    const report = await runInvestigation(c, first, { title: "alpha review", maxEvidence: 2 });
    assert.equal(report.investigation.status, "CLOSED");
    assert.equal(report.investigation.subject_entity_id, first);
    assert.equal(report.investigation.title, "alpha review");
    assert.equal(report.steps.at(-1)?.kind, "CONCLUSION");
    assert.equal(report.evidenceEvents.length, 2);
    assert.ok(report.evidenceEvents.every((id) => events.includes(id)));
    for (const step of report.steps) {
      assert.ok(step.content.length > 0);
      if (step.kind === "EVIDENCE") assert.ok(step.source_event_id);
    }

    const relationsAfter = (await db.query<{ count: string }>(`SELECT count(*)::text count FROM ip_entity_relations`)).rows[0].count;
    assert.equal(relationsAfter, relationsBefore);

    const again = await runInvestigation(c, first, { title: "alpha review", maxEvidence: 2 });
    assert.deepEqual(again.observations, report.observations);
    assert.deepEqual(again.evidenceEvents, report.evidenceEvents);
    assert.equal(again.investigation.status, "CLOSED");
    assert.notEqual(again.investigation.id, report.investigation.id);

    await assert.rejects(runInvestigation(c, randomUUID()), InvestigationError);
    await assert.rejects(runInvestigation(c, first, { maxEvidence: -1 }), InvestigationError);

    const zeroEvidence = await runInvestigation(c, second, { title: "no evidence mode", maxEvidence: 0 });
    assert.equal(zeroEvidence.evidenceEvents.length, 0);
    assert.ok(zeroEvidence.steps.every((step) => step.kind !== "EVIDENCE"));
  } finally {
    await db.close();
  }
});
