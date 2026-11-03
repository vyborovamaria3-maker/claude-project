#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  sourceConnection, checkPgOutbox, checkDestination, destinationConnection,
} from "./etl-connections.mjs";
import { validateRegistryEvent, registryEventFingerprint } from "../dist/index.js";

export function parseArguments(args) {
  const options = { source: null, limit: 100, execute: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--execute") { options.execute = true; continue; }
    if (arg === "--source") { options.source = args[++i] ?? null; continue; }
    if (arg.startsWith("--source=")) { options.source = arg.slice(9); continue; }
    if (arg === "--limit") { options.limit = Number(args[++i]); continue; }
    if (arg.startsWith("--limit=")) { options.limit = Number(arg.slice(8)); continue; }
    throw new Error("unknown CLI option");
  }
  if (options.help) return options;
  if (!["x", "tg", "blockchain"].includes(options.source)) throw new Error("select --source x|tg|blockchain");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error("limit must be 1..1000");
  }
  return options;
}

export function registryEventFromOutboxRow(row, expected) {
  let payload = row.payload;
  if (typeof payload === "string") payload = JSON.parse(payload);
  if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "registryEvent")) {
    throw new TypeError("source outbox row has no registryEvent");
  }
  const event = validateRegistryEvent(payload.registryEvent);
  if (
    event.sourceSystem !== row.source_system ||
    event.eventKind !== row.event_kind ||
    event.eventKey !== row.event_key ||
    event.schemaVersion !== row.schema_version ||
    event.sourceSystem !== expected.source_system ||
    event.eventKind !== expected.event_kind ||
    event.eventKey !== expected.event_key ||
    event.schemaVersion !== expected.schema_version ||
    event.evidenceRef.sourceId !== expected.evidence_source_id
  ) {
    throw new TypeError("source outbox identity does not match legacy inbox row");
  }
  return event;
}

async function findSourceRows(source, expected) {
  if (source.kind === "sqlite") {
    return source.connection.prepare(
      "SELECT source_system,event_kind,event_key,schema_version,payload " +
      "FROM outbox_events WHERE source_system=? AND event_kind=? AND event_key=? LIMIT 2"
    ).all(expected.source_system, expected.event_kind, expected.event_key);
  }
  const client = await source.connection.connect();
  let open = false;
  try {
    await client.query("BEGIN READ ONLY");
    open = true;
    const result = await client.query(
      "SELECT source_system,event_kind,event_key,schema_version,payload " +
      "FROM outbox_events WHERE source_system=$1 AND event_kind=$2 AND event_key=$3 LIMIT 2",
      [expected.source_system, expected.event_kind, expected.event_key],
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

/** Bounded source-read / destination-write repair. Source databases are never mutated. */
export async function backfillPendingFingerprints({ source, destination, sourceName, limit = 100, execute = false }) {
  const pending = await destination.query(
    "SELECT source_system,event_kind,event_key,schema_version,evidence_source_id " +
    "FROM intelligence_inbox WHERE source_system=$1 AND payload_sha256 IS NULL " +
    "ORDER BY ingested_at,event_key LIMIT $2",
    [sourceName, limit],
  );
  let fingerprinted = 0;
  for (const row of pending.rows) {
    const matches = await findSourceRows(source, row);
    if (matches.length !== 1) {
      throw new Error("source outbox event missing or ambiguous; refusing legacy fingerprint backfill");
    }
    const event = registryEventFromOutboxRow(matches[0], row);
    const hash = registryEventFingerprint(event);
    if (execute) {
      const updated = await destination.query(
        "UPDATE intelligence_inbox SETüÁå±½}Í¡ÈÔØôØ¬(]!IÍ½ÕÉ}ÍåÍÑ´ôÄ9Ù¹Ñ}­¥¹ôÈ9Ù¹Ñ}­äôÌ¬(9Í¡µ}ÙÉÍ¥½¸ôÐ9Ù¥¹}Í½ÕÉ}¥ôÔ9Áå±½}Í¡ÈÔØ%L9U10¬(IQUI9%9Ù¹Ñ}­ä°(mÉ½Ü¹Í½ÕÉ}ÍåÍÑ´°É½Ü¹Ù¹Ñ}­¥¹°É½Ü¹Ù¹Ñ}­ä°É½Ü¹Í¡µ}ÙÉÍ¥½¸°É½Ü¹Ù¥¹}Í½ÕÉ}¥°¡Í¡t°(¤ì(¥¡ÕÁÑ¹É½ÝÌ¹±¹Ñ ôôÄ¤Ñ¡É½Ü¹ÜÉÉ½È ±ä¥¹½à¥¹ÉÁÉ¥¹ÐÕÁÑ±½ÍÐ¥ÑÌ½µÁÉµ¹µÍÐ¤ì(ô(¥¹ÉÁÉ¥¹Ñ¬¬ì(ô(ÉÑÕÉ¸ìÍ½ÕÉèÍ½ÕÉ9µ°áµ¥¹èÁ¹¥¹¹É½ÝÌ¹±¹Ñ °¥¹ÉÁÉ¥¹Ñ°ÉåIÕ¸èáÕÑôì)ô()Õ¹Ñ¥½¸ÕÍ ¤ì(ÉÑÕÉ¸l(	½Õ¹ÉÁ¥È½È±ä%¹Ñ±±¥¹¥¹½àÉ½ÝÌÝ¥Ñ 9U10Áå±½}Í¡ÈÔØ¸°(¹Á´ÉÕ¸Ñ°é¥¹ÉÁÉ¥¹Ðµ­¥±°´´´µÍ½ÕÉáñÑñ±½­¡¥¸´µ±¥µ¥ÐÄÀÀ°(%9Q11%9}%9IAI%9Q}	-%11}9	1õÑÉÕ¹Á´ÉÕ¸Ñ°é¥¹ÉÁÉ¥¹Ðµ­¥±°´´´µÍ½ÕÉà´µ±¥µ¥ÐÄÀÀ´µáÕÑ°(Õ±Ð¥ÌÉµ½¹±äÉäµÉÕ¸¸´µáÕÑÝÉ¥ÑÌ¥¹ÉÁÉ¥¹ÑÌÑ¼%¹Ñ±±¥¹½¹±ä¸°(M½ÕÉ½ÕÑ½à¥ÌÉµ½¹±äì¹¼Í½ÕÉµ¥ÉÑ¥½¹Ì°±¥µÌ°-Ì½È½±±Ñ½ÈÍÑÉÑÌ¸°(IÅÕ¥ÉÌµ¥ÉÑ¥½¹ÌÀÀÄ¬ÀÀÈ¬ÀÀÐ¬ÀÄÜì¬ÀÀÔ½È±½­¡¥¸¸°(t¹©½¥¸ q¸¤ì)ô()Íå¹Õ¹Ñ¥½¸µ¥¸ ¤ì(½¹ÍÐ½ÁÑ¥½¹ÌôÁÉÍÉÕµ¹ÑÌ¡ÁÉ½ÍÌ¹ÉØ¹Í±¥ È¤¤ì(¥¡½ÁÑ¥½¹Ì¹¡±À¤ì½¹Í½±¹±½¡ÕÍ ¤¤ìÉÑÕÉ¸ìô(¥¡½ÁÑ¥½¹Ì¹áÕÑÁÉ½ÍÌ¹¹Ø¹%9Q11%9}%9IAI%9Q}	-%11}9	1ôôÑÉÕ¤ì(Ñ¡É½Ü¹ÜÉÉ½È ¥¹ÉÁÉ¥¹Ñ}­¥±±}½ÁÑ}¥¹}ÉÅÕ¥É¤ì(ô(½¹ÍÐÍ½ÕÉôÍ½ÕÉ½¹¹Ñ¥½¸¡½ÁÑ¥½¹Ì¹Í½ÕÉ°±Í¤ì(±ÐÍÑ¥¹Ñ¥½¸ì(ÑÉäì(¥¡Í½ÕÉ¹­¥¹ôôôÁ¤Ý¥Ð¡­A=ÕÑ½à¡Í½ÕÉ¹½¹¹Ñ¥½¸¤ì(ÍÑ¥¹Ñ¥½¸ôÍÑ¥¹Ñ¥½¹½¹¹Ñ¥½¸ ¤ì(Ý¥Ð¡­ÍÑ¥¹Ñ¥½¸¡ÍÑ¥¹Ñ¥½¸°ìÉÅÕ¥É	±½­¡¥¹IÙ¥Í¥½¹Ìè½ÁÑ¥½¹Ì¹Í½ÕÉôôô±½­¡¥¸ô¤ì(½¹ÍÐÉÍÕ±ÐôÝ¥Ð­¥±±A¹¥¹¥¹ÉÁÉ¥¹ÑÌ¡ì(Í½ÕÉ°ÍÑ¥¹Ñ¥½¸°Í½ÕÉ9µè½ÁÑ¥½¹Ì¹Í½ÕÉ°±¥µ¥Ðè½ÁÑ¥½¹Ì¹±¥µ¥Ð°áÕÑè½ÁÑ¥½¹Ì¹áÕÑ°(ô¤ì(½¹Í½±¹±½¡)M=8¹ÍÑÉ¥¹¥ä¡ÉÍÕ±Ð¤¤ì(ô¥¹±±äì(¥¡ÍÑ¥¹Ñ¥½¸¤Ý¥ÐÍÑ¥¹Ñ¥½¸¹¹ ¤ì(Ý¥ÐÍ½ÕÉ¹±½Í ¤ì(ô)ô()½¹ÍÐ¥Í¹ÑÉåÁ½¥¹ÐôÁÉ½ÍÌ¹ÉÙlÅtÁÑ¡Q½¥±UI0¡ÉÍ½±Ù¡ÁÉ½ÍÌ¹ÉÙlÅt¤¤¹¡Éôôô¥µÁ½ÉÐ¹µÑ¹ÕÉ°ì)¥¡¥Í¹ÑÉåÁ½¥¹Ð¤µ¥¸ ¤¹Ñ ¡ÉÉ½Èôøì(½¹ÍÐÍôÉÉ½È¥¹ÍÑ¹½ÉÉ½ÈÉÉ½È¹µÍÍôôô¥¹ÉÁÉ¥¹Ñ}­¥±±}½ÁÑ}¥¹}ÉÅÕ¥Éì(½¹Í½±¹ÉÉ½È %¹Ñ±±¥¹¥¹ÉÁÉ¥¹Ð­¥±°¥±è°ÍüÉÉ½È¹µÍÍèÍ½ÕÉ}½É}ÍÑ¥¹Ñ¥½¹}½ÁÉÑ¥½¹}¥±¤ì(ÁÉ½ÍÌ¹á¥Ñ½ôÄì)ô¤ìÿÿÿ