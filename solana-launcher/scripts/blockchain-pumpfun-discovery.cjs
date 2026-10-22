"use strict";

const { isSolanaAddress } = require("./blockchain-seed-core.cjs");

// Pump.fun program ID. A launch is only accepted when the enriched transaction
// names Pump.fun and the actual instruction accounts match this program. We
// never substitute feePayer for creator: a relayer can pay the fee.
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

function accountAddress(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["pubkey", "address", "publicKey"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return null;
}
function instructionName(ix) {
  const values = [
    ix?.instructionName, ix?.name, ix?.parsed?.type,
    ix?.parsed?.instructionName, ix?.parsed?.info?.instructionName,
  ];
  return values.find(v => typeof v === "string")?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
}
function allInstructions(tx) {
  const out = [];
  const visit = list => {
    if (!Array.isArray(list)) return;
    for (const ix of list) {
      if (!ix || typeof ix !== "object") continue;
      out.push(ix);
      visit(ix.innerInstructions);
    }
  };
  visit(tx?.instructions);
  return out;
}
// Confirmed against the saved MBC create_v2 receipt. Unsupported layouts stay
// undiscovered; a fee payer, mint authority or a token holder is not a creator.
function rawPumpFunLaunches(tx) {
  const raw = tx?.raw;
  if (!raw || raw.meta?.err !== null || tx.transactionError != null ||
      tx.error != null || !raw.transaction?.message ||
      raw.transaction.signatures?.[0] !== tx.signature) return [];
  const bs58 = require("bs58").default;
  const readPrefix = bytes => {
    let offset = 8;
    const strings = [];
    for (let i = 0; i < 3; i++) {
      if (offset + 4 > bytes.length) throw new Error("short string length");
      const length = bytes.readUInt32LE(offset); offset += 4;
      if (length > 16384 || offset + length > bytes.length) throw new Error("short string");
      strings.push(bytes.subarray(offset, offset + length).toString("utf8")); offset += length;
    }
    return { strings, offset };
  };
  const events = [], stack = [];
  try {
    for (const line of raw.meta.logMessages || []) {
      const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
      if (invoke) {
        if (Number(invoke[2]) !== stack.length + 1) return [];
        stack.push(invoke[1]); continue;
      }
      const exit = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
      if (exit) { if (stack.pop() !== exit[1]) return []; continue; }
      if (stack.at(-1) !== PUMP_FUN_PROGRAM_ID || !line.startsWith("Program data: ")) continue;
      const bytes = Buffer.from(line.slice(14), "base64");
      if (bytes.subarray(0, 8).toString("hex") !== "1b72a94ddeeb6376") continue;
      const prefix = readPrefix(bytes), o = prefix.offset;
      if (bytes.length < o + 128) return [];
      events.push({ ...prefix, mint: bs58.encode(bytes.subarray(o, o + 32)),
        curve: bs58.encode(bytes.subarray(o + 32, o + 64)),
        user: bs58.encode(bytes.subarray(o + 64, o + 96)),
        creator: bs58.encode(bytes.subarray(o + 96, o + 128)) });
    }
    if (stack.length) return [];
    const instructions = [...(raw.transaction.message.instructions || []),
      ...(raw.meta.innerInstructions || []).flatMap(g => g.instructions || [])];
    const launches = [];
    for (const ix of instructions) {
      if (ix.programId !== PUMP_FUN_PROGRAM_ID || typeof ix.data !== "string") continue;
      const bytes = Buffer.from(bs58.decode(ix.data));
      if (bytes.subarray(0, 8).toString("hex") !== "d6904cec5f8b31b4") continue;
      const prefix = readPrefix(bytes), o = prefix.offset;
      // Two retained successful create_v2 receipts have 34/43-byte tails.
      // Their common creator prefix is independently matched to CreateEvent;
      // trailing options are not interpreted as creator or mint evidence.
      if (![34, 43].includes(bytes.length - o) || bytes[o + 32] > 1 || bytes[o + 33] > 1) continue;
      const accounts = (ix.accounts || []).map(accountAddress);
      const requestedCreator = bs58.encode(bytes.subarray(o, o + 32)), mint = accounts[0];
      if (!isSolanaAddress(requestedCreator) || !isSolanaAddress(mint)) continue;
      const matches = events.filter(e => e.mint === mint &&
        (e.creator === requestedCreator || (bytes.length - o === 43 && requestedCreator === accounts[5])) &&
        e.curve === accounts[2] && e.user === accounts[5] &&
        e.strings.every((s, i) => s === prefix.strings[i]));
      if (matches.length !== 1) continue;
      const event = matches[0], creator = event.creator;
      launches.push({ creator, launchedBy: event.user, mint, signature: tx.signature,
        slot: Number.isSafeInteger(tx.slot) ? tx.slot : null,
        timestamp: Number.isSafeInteger(tx.timestamp) ? tx.timestamp : null,
        evidenceSource: "alchemy_raw_pump_fun_create_v2_and_event",
        evidence: { programId: PUMP_FUN_PROGRAM_ID, instructionName: "create_v2",
          creatorSource: creator === requestedCreator ? "instruction_arguments_and_CreateEvent" : "CreateEvent_override",
          requestedCreator, eventCreator: creator, mintAccountIndex: 0,
          user: accounts[5], bondingCurve: accounts[2], decoderCoverage: "create_v2_only" } });
    }
    return launches;
  } catch { return []; }
}
function extractPumpFunLaunches(transactions) {
  const found = new Map();
  for (const tx of transactions || []) {
    if (!tx || typeof tx.signature !== "string" || !tx.signature ||
        tx.transactionError != null || tx.error != null) continue;
    for (const launch of rawPumpFunLaunches(tx)) found.set(launch.creator + ":" + launch.mint, launch);
    if (tx.source !== "PUMP_FUN" || !["CREATE", "TOKEN_MINT"].includes(String(tx.type || "").toUpperCase())) continue;
    for (const ix of allInstructions(tx)) {
      if (ix.programId !== PUMP_FUN_PROGRAM_ID) continue;
      const name = instructionName(ix);
      // Enhanced payloads can omit instruction names. In that case require both
      // a CREATE/TOKEN_MINT transaction classification and the exact Pump.fun
      // program; still use only the known create account layout as evidence.
      if (name && !/(create|createtoken)/.test(name)) continue;
      const accounts = Array.isArray(ix.accounts) ? ix.accounts.map(accountAddress) : [];
      const info = ix.parsed?.info && typeof ix.parsed.info === "object" ? ix.parsed.info : {};
      const creator = [info.creator, info.user, info.owner].find(isSolanaAddress) || accounts[1] || null;
      const mint = [info.mint, info.tokenMint].find(isSolanaAddress) || accounts[2] || null;
      if (!isSolanaAddress(creator) || !isSolanaAddress(mint)) continue;
      const launch = {
        creator, mint, signature: tx.signature,
        slot: Number.isSafeInteger(tx.slot) ? tx.slot : null,
        timestamp: Number.isSafeInteger(tx.timestamp) ? tx.timestamp : null,
        evidenceSource: "helius_enhanced_pump_fun_create_instruction",
        evidence: {
          programId: ix.programId, instructionName: name || null,
          creatorAccountIndex: info.creator || info.user || info.owner ? null : 1,
          mintAccountIndex: info.mint || info.tokenMint ? null : 2,
          transactionSource: tx.source, transactionType: tx.type,
        },
      };
      const key = creator + ":" + mint;
      const prior = found.get(key);
      if (!prior || (launch.timestamp || 0) < (prior.timestamp || 0)) found.set(key, launch);
    }
  }
  return [...found.values()];
}

module.exports = { PUMP_FUN_PROGRAM_ID, extractPumpFunLaunches };
