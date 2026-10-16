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
function extractPumpFunLaunches(transactions) {
  const found = new Map();
  for (const tx of transactions || []) {
    if (!tx || typeof tx.signature !== "string" || !tx.signature ||
        tx.transactionError != null || tx.error != null) continue;
    if (tx.source !== "PUMP_FUN" || !["CREATE", "TOKEN_MINT"].includes(String(tx.type || "").toUpperCase())) continue;
    for (const ix of allInstructions(tx)) {
      if (ix.programId !== PUMP_FUN_PROGRAM_ID) continue;
      const name = instructionName(ix);
      // Enhanced payloads can omit instruction names. In that case require both
      // a CREATE/TOKEN_MINT transaction classification and the exact Pump.fun
      // program; still use only the known create account layout as evidence.
      if (name && !/(^|create|createv2|createtoken)/.test(name)) continue;
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
