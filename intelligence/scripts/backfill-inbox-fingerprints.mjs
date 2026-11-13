#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sourceConnection, checkPgOutbox, checkDestination, destinationConnection } from "./etl-connections.mjs";
import { validateRegistryEvent, registryEventFingerprint } from "../dist/index.js";

export function parseArguments(args) {
  const options = { source: null, limit: 100, execute: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--source") options.source = args[++i] ?? null;
    else if (arg.startsWith("--source=")) options.source = arg.slice(9);
    else if (arg === "--limit") options.limit = Number(args[++i]);
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice(8));
    else throw new Error("unknown CLI option");
  }
  if (!options.help && !["x", "tg", "blockchain"].includes(options.source)) {
    throw new Error("select --source x|tg|blockchain");
  }
  if (!options.help && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error("limit must be 1..1000");
  }
  return options;
}

export function eventFromOutbox(row, expected) {
  let payload = row.payload;
  if (typeof payload === "string") payload = JSON.parse(payload);
  if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "registryEvent")) {
    throw new TypeError("source outbox row has no registryEvent");
  }
  const event = validateRegistryEvent(payload.registryEvent);
  if (event.sourceSystem !== row.source_system ||
      event.eventKind !== row.event_kind ||
      event.eventKey !== row.event_key ||
      event.schemaVersion !== row.schema_version ||
      event.sourceSystem !== expected.source_system ||
      event.eventKind !== expected.event_kind ||
      event.eventKey !== expected.event_key ||
      event.schemaVersion !== expected.schema_version ||
      event.evidenceRef.sourceId !== expected.evidence_source_id) {
    throw new TypeError("source outbox identity does not match legacy inbox row");
  }
  return event;
}

async function findSourceEvent(source, row) {
  const query = "SELECT source_system,event_kind,event_key,schema_version,payload FROM outbox_events " +
    "WHERE source_system=? AND event_kind=? AND event_key=? LIMIT 2";
  if (source.kind === "sqlite") {
    return source.connection.prepare(query).all(row.source_system, row.event_kind, row.event_key);
  }
  const client = await source.connection.connect();
  let open = false;
  try {
    await client.query("BEGIN READ ONLY");
    open = true;
    const result = await client.query(
      "SELECT source_system,event_kind,event_key,schema_version,payload FROM outbox_events " +
      "WHERE source_system=$1 AND event_kind=$2 AND event_key=$3 LIMIT 2",
      [row.source_system, row.event_kind, row.event_key],
    );
    await client.query("COMMIT");
    open = false;
    return result.rows;
  } catch (error) {
    if (open) { try { await client.query("ROLLBACK"); } catch {} }
    throw error;
  } finally {
    client.release();
  }
}

export async function backfillPending({ source, destination, sourceName, limit = 100, execute = false }) {
  const pending = await destination.query(
    "SELECT source_system,event_kind,event_key,schema_version,evidence_source_id FROM intelligence_inbox " +
    "WHERE source_system=$1 AND payload_sha256 IS NULL " +
    "AND NOT (source_system='x' AND schema_version='x-unattributed-snapshot-v1') " +
    "ORDER BY ingested_at,event_key LIMIT $2",
    [sourceName, limit],
  );
  let fingerprinted = 0;
  for (const row of pending.rows) {
    const matches = await findSourceEvent(source, row);
    if (matches.length !== 1) throw new Error("source outbox event missing or ambiguous");
    const hash = registryEventFingerprint(eventFromOutbox(matches[0], row));
    if (execute) {
      const updated = await destination.query(
        "UPDATE intelligence_inbox SET payload_sha256=$6 WHERE source_system=$1 AND event_kind=$2 " +
        "AND event_key=$3 AND schema_version=$4 AND evidence_source_id=$5 " +
        "AND payload_sha256 IS NULL RETURNING event_key",
        [row.source_system, row.event_kind, row.event_key, row.schema_version, row.evidence_source_id, hash],
      );
      if (updated.rows.length !== 1) throw new Error("fingerprint compare-and-set failed");
    }
    fingerprinted++;
  }
  return { source: sourceName, examined: pending.rows.length, fingerprinted, dryRun: !execute };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Dry-run: npm run etl:fingerprint-backfill -- --source x|tg|blockchain --limit 100\n" +
      "Write: INTELLIGENCE_FINGERPRINT_BACKFILL_ENABLED=true npm run etl:fingerprint-backfill -- --source x --limit 100 --execute\n" +
      "Source outbox is read-only; only Intelligence payload_sha256 is updated. No migrations, claims, ACKs or collectors.");
    return;
  }
  if (options.execute && process.env.INTELLIGENCE_FINGERPRINT_BACKFILL_ENABLED !== "true") {
    throw new Error("explicit backfill opt-in required");
  }
  const source = sourceConnection(options.source, false);
  let destination;
  try {
    if (source.kind === "pg") await checkPgOutbox(source.connection);
    destination = destinationConnection();
    await checkDestination(destination, {
      requireBlockchainRevisions: options.source === "blockchain",
      allowLegacyFingerprints: true,
    });
    const result = await backfillPending({
      source, destination, sourceName: options.source, limit: options.limit, execute: options.execute,
    });
    console.log(JSON.stringify(result));
  } finally {
    if (destination) await destination.end();
    await source.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error("fingerprint backfill failed: source_or_destination_operation_failed");
    process.exitCode = 1;
  });
}
