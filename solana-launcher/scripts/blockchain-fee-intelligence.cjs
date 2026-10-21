#!/usr/bin/env node
"use strict";
// OFFLINE evidence-only fee projection. Input SQLite is always read-only.
// Output must be a NEW SQLite file. No network, canonical trades, or PnL writes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { buildFeeRollups } = require("./blockchain-fee-rollup.cjs");
const { inspectNativeBalances } = require("./blockchain-fee-balance-check.cjs");
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVATIONS = 5000;
const SYSTEM = "11111111111111111111111111111111";
function atomic(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d{1,40}$/.test(value)) return BigInt(value);
  return null;
}
function address(a) {
  if (typeof a === "string") return a;
  if (a && typeof a.pubkey === "string") return a.pubkey;
  return null;
}
function feeRegistry(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Registry must be an object");
  const tips = value.tips instanceof Set ? [...value.tips] : (value.jito_tip_accounts || []);
  const services = value.services || [];
  if (!Array.isArray(tips) || !Array.isArray(services) || tips.length > 100 || services.length > 200)
    throw new Error("Registry arrays invalid or oversized");
  for (const tip of tips) if (typeof tip !== "string" || !tip.trim()) throw new Error("Invalid tip recipient");
  for (const s of services) {
    if (!s || typeof s.id !== "string" || !s.id.trim() || typeof s.recipient !== "string" || !s.recipient.trim()
      || (s.from_slot != null && (!Number.isSafeInteger(s.from_slot) || s.from_slot < 0))
      || (s.to_slot != null && (!Number.isSafeInteger(s.to_slot) || s.to_slot < 0)))
      throw new Error("Invalid service registry row");
  }
  return { tips: new Set(tips), services };
}
function extractFees(tx, registry = feeRegistry()) {
  if (!tx || typeof tx !== "object" || !tx.signature) throw new Error("Missing signature");
  const raw = tx.raw || tx;
  const meta = raw.meta || raw.transaction?.meta;
  const message = raw.transaction?.message || raw.message;
  const keys = message?.accountKeys;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, "err") || !Array.isArray(keys))
    throw new Error("Missing execution metadata or account keys");
  const innerSig = raw.transaction?.signatures?.[0] || raw.signatures?.[0];
  if (innerSig && innerSig !== tx.signature) throw new Error("Conflicting signature");
  const payer = address(keys[0]);
  const events = [];
  const fee = atomic(meta.fee);
  if (fee === null) throw new Error("Missing exact network fee");
  events.push({key:"network",kind:"network_total",amountAtomic:fee.toString(),asset:"SOL",
    payer,recipient:null,status:"EXACT_ONCHAIN",economicRole:"INDEPENDENT",
    evidence:"raw.meta.fee",classificationReason:"Includes base and priority; components not separately added"});
  // On unsuccessful execution, transfers do not settle, but meta.fee is still charged.
  if (meta.err !== null) return events;
  const slot = Number.isSafeInteger(tx.slot) ? tx.slot : (Number.isSafeInteger(raw.slot) ? raw.slot : null);
  const instructions = [];
  for (const [i, ix] of (message.instructions || []).entries()) instructions.push({key:"outer:"+i,ix});
  for (const group of meta.innerInstructions || []) {
    if (!Number.isInteger(group?.index) || !Array.isArray(group.instructions)) continue;
    for (const [i,ix] of group.instructions.entries()) instructions.push({key:"inner:"+group.index+":"+i,ix});
  }
  for (const {key,ix} of instructions) {
    if (!ix || !((ix.programId === SYSTEM) || (ix.program === "system"))) continue;
    if (ix.parsed?.type !== "transfer") continue; // rent/account setup is not a fee
    const info = ix.parsed.info;
    const from = info?.source, to = info?.destination, n = atomic(info?.lamports);
    if (typeof from !== "string" || typeof to !== "string" || !from || !to || from === to || n === null || n === 0n)
      continue;
    // Conflicting registry claims are ambiguity, not proof of a fee type.
    const matches = registry.services.filter(s => s.recipient === to
      && ((s.from_slot == null && s.to_slot == null) || slot !== null)
      && (s.from_slot == null || slot >= s.from_slot)
      && (s.to_slot == null || slot <= s.to_slot));
    if (registry.tips.has(to) && matches.length) continue;
    let kind, serviceId = null, reason;
    if (registry.tips.has(to)) {kind="jito_tip_candidate";reason="known_tip_recipient_transfer_not_bundle_proof";}
    else {
      if (matches.length !== 1) continue;
      kind="service_fee_candidate"; serviceId=matches[0].id;
      reason="registered_recipient_only_not_proof_of_service_fee";
    }
    events.push({key,kind,amountAtomic:n.toString(),asset:"SOL",payer:from,recipient:to,
      serviceId,status:"CANDIDATE",economicRole:"INDEPENDENT",evidence:key,classificationReason:reason});
  }
  return events;
}
function decodeEvidence(row) {
  if (!Buffer.isBuffer(row.payload_gzip) || !Number.isSafeInteger(row.payload_bytes)
    || row.payload_bytes <= 0 || row.payload_bytes > MAX_RAW_BYTES) throw new Error("Invalid payload size");
  const bytes = gunzipSync(row.payload_gzip,{maxOutputLength:row.payload_bytes});
  if (bytes.length !== row.payload_bytes) throw new Error("Payload length mismatch");
  const tx = JSON.parse(bytes.toString("utf8"));
  if (!tx || typeof tx !== "object" || tx.signature !== row.signature) throw new Error("Signature mismatch");
  // A freshly computed hash without a stored source fingerprint is not a proof of integrity.
  if (typeof row.payload_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.payload_hash))
    throw new Error("Missing trusted RAW hash");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (row.payload_hash !== hash) throw new Error("RAW hash mismatch");
  if (row.slot != null && tx.slot != null && row.slot !== tx.slot)
    throw new Error("RAW slot mismatch");
  const eventTime = tx.blockTime ?? tx.timestamp ?? null;
  if (row.block_time != null && eventTime != null && row.block_time !== eventTime)
    throw new Error("RAW block time mismatch");
  return {tx, hash};
}
function prepareOutput(db) {
  db.exec(`CREATE TABLE fee_projection_info (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE fee_evidence (
    target_kind TEXT NOT NULL, target_address TEXT NOT NULL, signature TEXT NOT NULL,
    raw_revision INTEGER NOT NULL, raw_sha256 TEXT NOT NULL, event_key TEXT NOT NULL,
    slot INTEGER, block_time INTEGER, fee_kind TEXT NOT NULL, amount_atomic TEXT NOT NULL,
    asset TEXT NOT NULL, payer TEXT, recipient TEXT, service_id TEXT, classification_status TEXT NOT NULL,
    economic_role TEXT NOT NULL, evidence_path TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY(target_kind,target_address,signature,raw_revision,event_key)
  );
  CREATE TABLE fee_balance_evidence (
    target_kind TEXT NOT NULL, target_address TEXT NOT NULL, signature TEXT NOT NULL,
    raw_revision INTEGER NOT NULL, raw_sha256 TEXT NOT NULL, balance_status TEXT NOT NULL,
    reason TEXT NOT NULL, delta_lamports TEXT,
    PRIMARY KEY(target_kind,target_address,signature,raw_revision)
  );
  CREATE INDEX idx_fee_balance_signature ON fee_balance_evidence(signature,balance_status);
  CREATE TABLE fee_invalid_observations (
    target_kind TEXT NOT NULL, target_address TEXT NOT NULL, signature TEXT NOT NULL,
    raw_revision INTEGER, reason TEXT NOT NULL,
    PRIMARY KEY(target_kind,target_address,signature)
  );
  CREATE INDEX idx_fee_invalid_signature ON fee_invalid_observations(signature);
  CREATE INDEX idx_fee_signature ON fee_evidence(signature,fee_kind);
  CREATE INDEX idx_fee_payer ON fee_evidence(payer,fee_kind);
  CREATE INDEX idx_fee_service ON fee_evidence(service_id,fee_kind);`);
}
function project(sourceDb, outputDb, options = {}) {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OBSERVATIONS) throw new Error("limit must be 1..5000");
  const registry = feeRegistry(options.registry);
  prepareOutput(outputDb);
  const hasEvents = sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_seed_events'").get();
  if (!hasEvents) throw new Error("Input is not a collector database");
  const sql = `SELECT kind,address,signature,raw_revision,payload_hash,payload_gzip,payload_bytes,slot,block_time
    FROM chain_seed_events ORDER BY kind,address,signature LIMIT ?`;
  const insert = outputDb.prepare(`INSERT INTO fee_evidence(target_kind,target_address,signature,raw_revision,
    raw_sha256,event_key,slot,block_time,fee_kind,amount_atomic,asset,payer,recipient,service_id,
    classification_status,economic_role,evidence_path,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertBalance = outputDb.prepare(`INSERT INTO fee_balance_evidence
    (target_kind,target_address,signature,raw_revision,raw_sha256,balance_status,reason,delta_lamports)
    VALUES(?,?,?,?,?,?,?,?)`);
  const insertInvalid = outputDb.prepare(`INSERT OR REPLACE INTO fee_invalid_observations
    (target_kind,target_address,signature,raw_revision,reason) VALUES(?,?,?,?,?)`);
  const stats = {schema:"blockchain-fee-evidence-v1",diagnosticOnly:true,observations:0,invalidEvidence:0,
    networkFeeObservations:0,candidateTransfers:0,exportedEvents:0,balanceChecks:{MATCH:0,MISMATCH:0,UNAVAILABLE:0},
    limitations:["Only meta.fee is exact; its base/priority split is unknown.",
      "Recipient matches are candidates, not proven service fees or Jito bundle tips.",
      "No DEX embedded fees, SPL transfer fees, or historical FX rates are inferred.",
      "Duplicated signatures across targets are separate observations; do not sum them globally.",
      "Source is the latest RAW revision per target, not a completeness proof."]};
  const write = outputDb.transaction((row, decoded, events, balanceCheck) => {
    insertBalance.run(row.kind,row.address,row.signature,row.raw_revision||1,decoded.hash,
      balanceCheck.status,balanceCheck.reason,balanceCheck.deltaLamports);
    for (const e of events) insert.run(row.kind,row.address,row.signature,row.raw_revision||1,decoded.hash,
      e.key,row.slot,row.block_time,e.kind,e.amountAtomic,e.asset,e.payer,e.recipient,
      e.serviceId||null,e.status,e.economicRole,e.evidence,e.classificationReason);
  });
  for (const row of sourceDb.prepare(sql).iterate(limit)) {
    stats.observations++;
    let decoded,events;
    try {
      decoded = decodeEvidence(row);
      events = extractFees(decoded.tx,registry);
    } catch {
      stats.invalidEvidence++;
      insertInvalid.run(row.kind,row.address,row.signature,row.raw_revision||null,
        "raw_or_execution_evidence_invalid");
      continue;
    } // Bad RAW is retained as a quality blocker for the same signature.
    const check=inspectNativeBalances(decoded.tx.raw?.meta || decoded.tx.meta || decoded.tx.raw?.transaction?.meta);
    write(row,decoded,events,check); // Storage failure must abort, not masquerade as bad RAW.
    stats.balanceChecks[check.status]++;
    stats.networkFeeObservations++;
    stats.candidateTransfers += events.length-1;
    stats.exportedEvents += events.length;
  }
  // Reconcile per-signature before producing any aggregate; candidates remain candidates.
  stats.rollup = buildFeeRollups(outputDb);
  outputDb.prepare("INSERT INTO fee_projection_info(key,value) VALUES(?,?)")
    .run("run_manifest",JSON.stringify({...stats,limit,generatedAt:new Date().toISOString()}));
  return stats;
}
function parseArgs(argv) {
  const a = {limit:200};
  for (let i=0;i<argv.length;i++) {
    if (["--db","--out","--registry","--limit"].includes(argv[i]) && argv[i+1]) {
      const name=argv[i++].slice(2); a[name]=argv[i];
    } else throw new Error("Usage: --db source.db --out NEW.db [--limit 200] [--registry fee-registry.json]");
  }
  if (!a.db || !a.out) throw new Error("Explicit --db and --out NEW.db required");
  a.limit = Number(a.limit);
  if (!Number.isInteger(a.limit) || a.limit<1 || a.limit>MAX_OBSERVATIONS) throw new Error("Invalid limit");
  return a;
}
function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv), sourcePath=path.resolve(opts.db), outPath=path.resolve(opts.out);
  if (!fs.existsSync(sourcePath) || fs.existsSync(outPath) || sourcePath === outPath)
    throw new Error("Source must exist; output must not exist");
  const registry = opts.registry ? JSON.parse(fs.readFileSync(opts.registry,"utf8")) : {};
  feeRegistry(registry); // validate before creating an output file
  const Database=require("better-sqlite3");
  const source=new Database(sourcePath,{readonly:true,fileMustExist:true});
  let dest;
  try {
    source.pragma("query_only=ON");
    dest=new Database(outPath,{fileMustExist:false});
    const report=project(source,dest,{limit:opts.limit,registry});
    return {...report,output:outPath};
  } catch (e) {
    dest?.close(); dest=null;
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    throw e;
  } finally { dest?.close(); source.close(); }
}
if (require.main===module) {
  try { console.log(JSON.stringify(main(),null,2)); } catch (e) { console.error(e.message); process.exitCode=1; }
}
module.exports={atomic,address,feeRegistry,extractFees,decodeEvidence,project,parseArgs,main};
