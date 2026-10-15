#!/usr/bin/env node
"use strict";

// Read-only provider-evidence report. Never imports app DB initialization or env keys.
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { SOURCE_BITS, isSolanaAddress } = require("./blockchain-seed-core.cjs");
const MAX_PAYLOAD = 512 * 1024;

function integer(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? BigInt(value) : null;
}
function decode(row) {
  if (!Buffer.isBuffer(row.payload_gzip) || row.payload_gzip.length > MAX_PAYLOAD
      || !Number.isSafeInteger(row.payload_bytes) || row.payload_bytes < 1 || row.payload_bytes > MAX_PAYLOAD) throw new Error("invalid payload size");
  const raw = gunzipSync(row.payload_gzip, { maxOutputLength: row.payload_bytes });
  if (raw.length !== row.payload_bytes) throw new Error("payload size mismatch");
  const tx = JSON.parse(raw.toString("utf8"));
  if (!tx || typeof tx !== "object" || Array.isArray(tx) || tx.signature !== row.signature) throw new Error("signature mismatch");
  for (const field of ["nativeTransfers", "tokenTransfers"]) {
    if (tx[field] !== undefined && !Array.isArray(tx[field])) throw new Error("invalid transfers");
    if (tx[field]?.some(leg => !leg || typeof leg !== "object" || Array.isArray(leg))) throw new Error("invalid transfer leg");
  }
  if (tx.events !== undefined && (!tx.events || typeof tx.events !== "object" || Array.isArray(tx.events))) throw new Error("invalid events");
  if (tx.events?.swap) {
    if (typeof tx.events.swap !== "object" || Array.isArray(tx.events.swap)) throw new Error("invalid swap");
    for (const field of ["tokenInputs", "tokenOutputs"]) {
      if (tx.events.swap[field] !== undefined && !Array.isArray(tx.events.swap[field])) throw new Error("invalid swap legs");
      if (tx.events.swap[field]?.some(leg => !leg || typeof leg !== "object" || Array.isArray(leg))) throw new Error("invalid swap leg");
    }
  }
  return tx;
}

function aggregateTarget(db, target, options) {
  const { since, until, maxEvents, now } = options;
  const count = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN block_time IS NULL THEN 1 ELSE 0 END) AS unknownTimes FROM chain_seed_events WHERE kind=? AND address=?").get(target.kind, target.address);
  const windowCount = db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events WHERE kind=? AND address=? AND (? IS NULL OR block_time>=?) AND (? IS NULL OR block_time<?)").get(target.kind, target.address, since, since, until, until).n;
  const metrics = { validEvents: 0, failedTransactions: 0, corruptEvents: 0, invalidAmounts: 0,
    swapTransactions: 0, transferTransactions: 0, unknownTransactions: 0,
    simpleNativeBuys: 0, simpleNativeSells: 0, buyQuoteLamports: 0n, sellQuoteLamports: 0n,
    firstObservedBlockTime: null, lastObservedBlockTime: null,
    feePaidLamports: 0n, nativeInLamports: 0n, nativeOutLamports: 0n,
    tokenTransferLegs: 0, counterparties: new Set(), mints: new Set(), tokenFlows: new Map() };
  let scanned = 0;
  let payloadLimited = false;
  // LIMIT is per target; every omitted event is explicitly reported. SQLite cursor
  // and decompression bounds keep a corrupt/large history from exhausting memory.
  const rows = db.prepare("SELECT signature,block_time,payload_gzip,payload_bytes FROM chain_seed_events WHERE kind=? AND address=? AND (? IS NULL OR block_time>=?) AND (? IS NULL OR block_time<?) ORDER BY block_time DESC, signature LIMIT ?");
  for (const row of rows.iterate(target.kind, target.address, since, since, until, until, maxEvents)) {
    if (Number.isSafeInteger(row.payload_bytes) && row.payload_bytes > 0 && row.payload_bytes <= MAX_PAYLOAD) {
      if (row.payload_bytes > options.remainingBytes) { payloadLimited = true; break; }
      options.remainingBytes -= row.payload_bytes;
    }
    scanned++;
    let tx;
    try { tx = decode(row); } catch { metrics.corruptEvents++; continue; }
    metrics.validEvents++;
    if (Number.isSafeInteger(row.block_time) && row.block_time >= 0) {
      metrics.firstObservedBlockTime = Math.min(metrics.firstObservedBlockTime ?? row.block_time, row.block_time);
      metrics.lastObservedBlockTime = Math.max(metrics.lastObservedBlockTime ?? row.block_time, row.block_time);
    }
    function amount(value) {
      const n = integer(value);
      if (n === null) metrics.invalidAmounts++;
      return n;
    }
    if (target.kind === "wallet" && tx.feePayer === target.address && tx.fee !== undefined) {
      metrics.feePaidLamports += amount(tx.fee) ?? 0n;
    }
    // Failed transactions can pay fees but never contribute successful flows.
    if (tx.transactionError != null) { metrics.failedTransactions++; continue; }
    const swap = tx.events?.swap;
    const legs = [...(swap?.tokenInputs || []), ...(swap?.tokenOutputs || [])];
    const relevantSwap = Boolean(swap) && (target.kind === "token"
      ? legs.some(l => l?.mint === target.address)
      : legs.some(l => l?.userAccount === target.address)
        || swap.nativeInput?.account === target.address || swap.nativeOutput?.account === target.address);
    if (relevantSwap) {
      metrics.swapTransactions++;
      const inputs = swap.tokenInputs || [];
      const outputs = swap.tokenOutputs || [];
      // Only a single asset and matching owner can receive a native quote.
      const buy = inputs.length === 0 && outputs.length === 1 && swap.nativeInput && !swap.nativeOutput;
      const sell = outputs.length === 0 && inputs.length === 1 && swap.nativeOutput && !swap.nativeInput;
      const leg = buy ? outputs[0] : sell ? inputs[0] : null;
      const native = buy ? swap.nativeInput : sell ? swap.nativeOutput : null;
      if (leg && native && isSolanaAddress(leg.userAccount) && leg.userAccount === native.account
          && (target.kind === "token" ? leg.mint === target.address : leg.userAccount === target.address)) {
        const quote = amount(native.amount);
        const rawTokens = integer(leg.rawTokenAmount?.tokenAmount);
        if (quote !== null && quote > 0n && rawTokens !== null && rawTokens > 0n) {
          if (buy) { metrics.simpleNativeBuys++; metrics.buyQuoteLamports += quote; }
          else { metrics.simpleNativeSells++; metrics.sellQuoteLamports += quote; }
          if (leg.userAccount !== target.address) metrics.counterparties.add(leg.userAccount);
        }
      }
      for (const leg of legs) {
        if (!leg || !isSolanaAddress(leg.mint)) continue;
        if (target.kind === "wallet" && leg.userAccount !== target.address) continue;
        metrics.mints.add(leg.mint);
      }
      // Exact token units, grouped by mint AND decimals; never sum different assets.
      for (const [direction, list] of [["out", swap.tokenInputs || []], ["in", swap.tokenOutputs || []]]) {
        for (const leg of list) {
          if (!leg || !isSolanaAddress(leg.mint)) continue;
          if (target.kind === "wallet" ? leg.userAccount !== target.address : leg.mint !== target.address) continue;
          const decimals = leg.rawTokenAmount?.decimals;
          const n = amount(leg.rawTokenAmount?.tokenAmount);
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) { metrics.invalidAmounts++; continue; }
          if (n === null) continue;
          const key = leg.mint + ":" + decimals;
          const flow = metrics.tokenFlows.get(key) || { mint: leg.mint, decimals, inRaw: 0n, outRaw: 0n };
          flow[direction + "Raw"] += n;
          metrics.tokenFlows.set(key, flow);
        }
      }
    }
    let transferred = false;
    for (const transfer of tx.tokenTransfers || []) {
      if (!transfer || !isSolanaAddress(transfer.mint)) continue;
      const relevant = target.kind === "token" ? transfer.mint === target.address
        : transfer.fromUserAccount === target.address || transfer.toUserAccount === target.address;
      if (!relevant) continue;
      transferred = true;
      metrics.tokenTransferLegs++;
      metrics.mints.add(transfer.mint);
      // tokenAmount is a floating-point UI amount; deliberately not an exact volume.
      for (const account of [transfer.fromUserAccount, transfer.toUserAccount]) {
        if (isSolanaAddress(account) && account !== target.address) metrics.counterparties.add(account);
      }
    }
    if (target.kind === "wallet") for (const transfer of tx.nativeTransfers || []) {
      if (!transfer) continue;
      const incoming = transfer.toUserAccount === target.address;
      const outgoing = transfer.fromUserAccount === target.address;
      if (!incoming && !outgoing) continue;
      transferred = true;
      const n = amount(transfer.amount);
      if (n !== null) {
        if (incoming) metrics.nativeInLamports += n;
        if (outgoing) metrics.nativeOutLamports += n;
      }
      for (const account of [transfer.fromUserAccount, transfer.toUserAccount]) {
        if (isSolanaAddress(account) && account !== target.address) metrics.counterparties.add(account);
      }
    }
    if (transferred) metrics.transferTransactions++;
    if (!transferred && !relevantSwap) metrics.unknownTransactions++;
  }
  const reasons = [];
  if (target.last_success_at == null) reasons.push("never_collected");
  if (!target.backfill_complete) reasons.push("backfill_pending");
  if (target.possible_gap || target.forward_cursor) reasons.push("catchup_gap");
  if (target.last_error) reasons.push("collector_error");
  if (target.last_success_at != null && now - target.last_success_at > options.staleMs) reasons.push("stale");
  if (payloadLimited) reasons.push("report_payload_budget");
  else if (windowCount > scanned) reasons.push("report_event_limit");
  if (count.unknownTimes && (since !== null || until !== null)) reasons.push("undated_events_excluded");
  if (metrics.corruptEvents) reasons.push("corrupt_evidence");
  if (metrics.invalidAmounts) reasons.push("invalid_amounts");
  // Provider pagination exhaustion is narrower than complete blockchain coverage.
  return { kind: target.kind, address: target.address, active: target.source_mask !== 0,
    sourceCategories: Object.entries(SOURCE_BITS).filter(([, bit]) => target.source_mask & bit).map(([name]) => name),
    coverage: { scope: "stored_helius_address_history", chainComplete: false, reasons,
      providerBackfillExhausted: Boolean(target.backfill_complete), catchupPending: Boolean(target.forward_cursor || target.possible_gap),
      lastSuccessAtMs: target.last_success_at, storedEvents: count.n, windowEvents: windowCount,
      scannedEvents: scanned, omittedEvents: windowCount - scanned, unknownTimeEvents: count.unknownTimes || 0 },
    metrics: { ...metrics, uniqueCounterparties: metrics.counterparties.size, distinctMints: metrics.mints.size,
      counterparties: undefined, mints: undefined, tokenFlows: [...metrics.tokenFlows.values()].sort((a,b) => a.mint.localeCompare(b.mint) || a.decimals-b.decimals) },
    conclusions: { migrationVerified: null, realizedPnl: null, roi: null, profitable: null } };
}

function buildReport(db, input = {}) {
  const options = { since: null, until: null, maxEvents: 10000, limit: 50, offset: 0,
    staleMs: 24 * 3600000, maxBytes: 64 * 1024 * 1024, now: Date.now(), includeInactive: false, kind: null, address: null, ...input };
  options.remainingBytes = options.maxBytes;
  for (const key of ["maxEvents", "limit", "offset", "staleMs", "now", "maxBytes"]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "offset" || key === "now" ? 0 : 1)) throw new Error("Invalid " + key);
  }
  if (options.limit > 500 || options.maxEvents > 100000) throw new Error("Report limit too large");
  if (options.maxBytes > 64 * 1024 * 1024) throw new Error("Payload budget too large");
  if (options.limit * options.maxEvents > 1000000) throw new Error("Report work budget exceeds 1000000 events; reduce limit or max-events");
  for (const key of ["since", "until"]) if (options[key] !== null && (!Number.isSafeInteger(options[key]) || options[key] < 0)) throw new Error("Invalid " + key);
  if (options.since !== null && options.until !== null && options.since >= options.until) throw new Error("since must precede until");
  if (options.kind !== null && !["token", "wallet"].includes(options.kind)) throw new Error("Invalid kind");
  if (options.address !== null && !isSolanaAddress(options.address)) throw new Error("Invalid Solana address");
  return db.transaction(() => {
    const where = "WHERE (?=1 OR source_mask<>0) AND (? IS NULL OR kind=?) AND (? IS NULL OR address=?)";
    const params = [options.includeInactive ? 1 : 0, options.kind, options.kind, options.address, options.address];
    const totalTargets = db.prepare("SELECT COUNT(*) AS n FROM chain_seed_targets " + where).get(...params).n;
    const targets = db.prepare("SELECT * FROM chain_seed_targets " + where + " ORDER BY kind,address LIMIT ? OFFSET ?").all(...params, options.limit, options.offset);
    const report = { version: 1, generatedAtMs: options.now, evidence: "Helius parsed provider data; not independent RPC reconciliation",
      window: { sinceInclusiveSeconds: options.since, untilExclusiveSeconds: options.until },
      pagination: { totalTargets, offset: options.offset, returned: targets.length,
        nextOffset: options.offset + targets.length < totalTargets ? options.offset + targets.length : null },
      limitations: ["Excel categories are labels, not proof of migration or profitability",
        "Mint-address history does not include every trade of that token",
        "Direct wallet-address history can omit SPL token-account activity",
        "Native transfer flows are not profit or balance change; fees are separate",
        "Native quotes cover only single-asset parsed swaps with matching owners",
        "Swap raw token flows describe parsed legs, not holdings, prices, USD volume or realized PnL"],
      categoryCoverage: Object.entries(SOURCE_BITS).map(([category, bit]) => ({ category,
        ...db.prepare("SELECT COUNT(*) AS targets, COALESCE(SUM(CASE WHEN last_success_at IS NULL THEN 1 ELSE 0 END),0) AS neverCollected, COALESCE(SUM(CASE WHEN backfill_complete=0 THEN 1 ELSE 0 END),0) AS backfillPending, COALESCE(SUM(CASE WHEN possible_gap<>0 OR forward_cursor IS NOT NULL THEN 1 ELSE 0 END),0) AS catchupGaps, COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS collectorErrors FROM chain_seed_targets " + where + " AND (source_mask & ?)<>0").get(...params, bit) })),
      targets: targets.map(target => aggregateTarget(db, target, options)) };
    report.payloadBudget = { maxBytes: options.maxBytes, consumedBytes: options.maxBytes - options.remainingBytes };
    return JSON.parse(JSON.stringify(report, (_, value) => typeof value === "bigint" ? value.toString() : value));
  })();
}

function parseArgs(argv) {
  const flags = {};
  const allowed = new Set(["db", "since", "until", "max-events", "limit", "offset", "stale-hours", "kind", "address"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith("--")) throw new Error("Unexpected argument");
    if (["help", "include-inactive"].includes(key)) { flags[key] = true; continue; }
    if (!allowed.has(key) || !argv[i+1] || argv[i+1].startsWith("--")) throw new Error("Unknown/missing flag: " + key);
    flags[key] = argv[++i];
  }
  const options = { includeInactive: Boolean(flags["include-inactive"]) };
  for (const [flag, key] of [["since", "since"], ["until", "until"], ["max-events", "maxEvents"], ["limit", "limit"], ["offset", "offset"]]) {
    if (flags[flag] !== undefined) options[key] = Number(flags[flag]);
  }
  if (flags["stale-hours"] !== undefined) options.staleMs = Number(flags["stale-hours"]) * 3600000;
  for (const key of ["kind", "address"]) if (flags[key]) options[key] = flags[key];
  return { dbPath: path.resolve(flags.db || path.join(process.cwd(), "data/trade.db")), help: flags.help, options };
}
function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return console.log("Read-only Solana seed analytics JSON\n--db <existing trade.db> --kind token|wallet --address <public key>\n--since <unix seconds> --until <unix seconds> --limit 50 --offset 0\n--max-events 10000 --stale-hours 24 --include-inactive");
  const Database = require("better-sqlite3");
  const db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 5000");
    console.log(JSON.stringify(buildReport(db, args.options), null, 2));
  } finally { db.close(); }
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error("Seed analytics failed:", error.message); process.exitCode = 1; }
}
module.exports = { buildReport, decode, integer, parseArgs };
