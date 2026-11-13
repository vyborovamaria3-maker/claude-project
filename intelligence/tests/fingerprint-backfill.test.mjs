import test from "node:test";
import assert from "node:assert/strict";
import { buildEntityRef, buildEvidenceRef, formatTokenId } from "@claude-project/contracts";
import { parseArguments, eventFromOutbox, backfillPending } from "../scripts/backfill-inbox-fingerprints.mjs";

const at = "2026-10-18T00:00:00Z";
const event = {
  sourceSystem: "tg", eventKind: "message_observed", eventKey: "tg:-100111:17:v1",
  schemaVersion: "tg-message-v1",
  entityRefs: [buildEntityRef({
    kind: "token",
    canonicalId: formatTokenId("solana", "So11111111111111111111111111111111111111112"),
    firstSeenAt: at, lastSeenAt: at,
  })],
  evidenceRef: buildEvidenceRef({
    sourceKind: "tg_message", sourceAccountId: "-100111", messageId: "17", observedAt: at,
  }),
};
const inbox = {
  source_system: "tg", event_kind: event.eventKind, event_key: event.eventKey,
  schema_version: event.schemaVersion, evidence_source_id: event.evidenceRef.sourceId,
};
const sourceRow = { ...inbox, payload: { registryEvent: event } };

test("fingerprint backfill parser is bounded and defaults to dry-run", () => {
  assert.deepEqual(parseArguments(["--source", "tg"]), {
    source: "tg", limit: 100, execute: false, help: false,
  });
  assert.equal(parseArguments(["--source=x", "--limit=10", "--execute"]).execute, true);
  assert.throws(() => parseArguments(["--source", "unknown"]));
  assert.throws(() => parseArguments(["--source", "tg", "--limit", "1001"]));
});

test("source event must match the exact legacy inbox identity", () => {
  assert.equal(eventFromOutbox(sourceRow, inbox).eventKey, event.eventKey);
  assert.throws(() => eventFromOutbox(sourceRow, { ...inbox, evidence_source_id: "wrong" }), /identity/);
});

test("destination-only unattributed X snapshots are excluded from source-outbox backfill",async()=>{
  let selectedSql="";
  const source={kind:"sqlite",connection:{prepare:()=>({all:()=>{throw new Error("snapshot must not query source outbox");}})}};
  const destination={query:async sql=>{
    selectedSql=sql;
    return {rows:[]};
  }};
  const result=await backfillPending({source,destination,sourceName:"x",execute:false});
  assert.equal(result.examined,0);
  assert.match(selectedSql,/x-unattributed-snapshot-v1/);
});

test("dry-run never writes and execute uses a compare-and-set update", async () => {
  let writes = 0;
  const source = { kind: "sqlite", connection: { prepare: () => ({ all: () => [sourceRow] }) } };
  const destination = { query: async sql => {
    if (sql.includes("SELECT source_system")) return { rows: [inbox] };
    writes++;
    return { rows: [{ event_key: event.eventKey }] };
  }};
  const dry = await backfillPending({ source, destination, sourceName: "tg", execute: false });
  assert.deepEqual(dry, { source: "tg", examined: 1, fingerprinted: 1, dryRun: true });
  assert.equal(writes, 0);
  const applied = await backfillPending({ source, destination, sourceName: "tg", execute: true });
  assert.equal(applied.dryRun, false);
  assert.equal(writes, 1);
});
