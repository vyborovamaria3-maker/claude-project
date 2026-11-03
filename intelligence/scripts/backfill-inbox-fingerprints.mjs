#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sourceConnection, checkPgOutbox, checkDestination, destinationConnection } from "./etl-connections.mjs";
import { validateRegistryEvent, registryEventFingerprint } from "../dist/index.js";

export function parseArguments(args) {
  const o = { source: null, limit: 100, execute: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--execute") o.execute = true;
    else if (a === "--source") o.source = args[++i] ?? null;
    else if (a.startsWith("--source=")) o.source = a.slice(9);
    else if (a === "--limit") o.limit = Number(args[++i]);
    else if (a.startsWith("--limit=")) o.limit = Number(a.slice(8));
    else throw new Error("unknown CLI option");
  }
  if (!o.help && !["x", "tg", "blockchain"].includes(ow.source))) throw new Error("select --source x|tg|blockchain");
  if (!o.help && (!Number.isSafeInteger(o.limit) ||(o.limit < 1 ||(o.limit > 1000)))) throw new Error("limit must be 1..1000");
  return o;
}

export function eventFromOutbox(row, expected) {
  let payload = row.payload;
  if (typeof payload === "string") payload = JSON.parse(payload);
  if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "registryEvent")) throw new TypeError("missing registryEvent");
  const e = validateRegistryEvent(payload.registryEvent);
  if (e.sourceSystem !== row.source_system || e.eventKind !== row.event_kind ||
      e.eventKey !== row.event_key || e.schemaVersion !== row.schema_version ||
      e.sourceSystem !== expected.source_system || e.eventKind !== expected.event_kind ||
      e.eventKey !== expected.event_key || e.schemaVersion !== expected.schema_version ||
      e.evidenceRef.sourceId !== expected.evidence_source_id) throw new TypeError("source identity mismatch");
  return e;
}

Z³)Ü~éÜ¶*'~)İJ‹«qá/z{l¢êÜzº0r‰ì¶Ê¥HBÄ	;(º·³+-zg¯z{dŠw^½éí‘ì¬r¦j÷«²*'¥¬¥¡§EDã(ºÖèÅëŞÛ>XqÊ.­Ç¬ÊË^˜Cz÷§¶H§tCz÷§¶G²,ƒOhŸ²‹«qé"