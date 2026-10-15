#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { parseEvidence, computePnl, WSOL } = require("./blockchain-forensics-core.cjs");
const WALLET = "Wallet11111111111111111111111111111111111";
const OTHER = "Other111111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111";
const ALT = "Mint2222222222222222222222222222222222222";
const quote = (qty) => ({ tokenAmount: String(qty * 1000000), decimals: 6 });
function buy(signature, slot, qty, sol, opts = {}) {
  return { signature, timestamp: slot * 100, slot, feePayer: WALLET,
    fee: 5000, type: "SWAP", ...opts,
    events: { swap: { nativeInput: { account: WALLET, amount: String(sol * 1e9) },
      tokenOutputs: [{ userAccount: WALLET, mint: MINT, rawTokenAmount: quote(qty) }] } } };
}
function sell(signature, slot, qty, sol, opts = {}) {
  return { signature, timestamp: slot * 100, slot, feePayer: WALLET,
    fee: 5000, type: "SWAP", ...opts,
    events: { swap: { nativeOutput: { account: WALLET, amount: String(sol * 1e9) },
      tokenInputs: [{ userAccount: WALLET, mint: MINT, rawTokenAmount: quote(qty) }] } } };
}
const events = [...parseEvidence(buy("tx-buy", 1, 10, 2), WALLET),
  ...parseEvidence(sell("tx-sell", 2, 5, 1.5), WALLET)];
assert.deepEqual(events.map(e => e.kind), ["buy", "sell"]);
const verified = computePnl(events, true)[0];
assert.equal(verified.status, "verified");
assert(Math.abs(verified.totalRealizedPnlSol - (1.5 - 0.000005 - (2 + 0.000005)/2)) < 1e-9);
const missing = computePnl(events, false)[0];
assert.equal(missing.totalRealizedPnlSol, null);
assert.equal(missing.status, "unknown");
assert.equal(missing.knownSellCount, 0);
assert.equal(missing.knownRealizedPnlSol, null);
assert(missing.reasons.includes("history_incomplete"));
const transfer = { signature: "tx-transfer", slot: 3, timestamp: 300,
  feePayer: OTHER, fee: 5000, type: "TRANSFER",
  tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET,
    mint: MINT, tokenAmount: 7 }] };
const received = parseEvidence(transfer, WALLET);
assert.equal(received.length, 1);
assert.equal(received[0].kind, "transfer_in");
assert.equal(received[0].counterparty, OTHER);
const unknownBasis = computePnl([...received, ...parseEvidence(sell("sell-received", 4, 7, 2), WALLET)], true)[0];
assert.equal(unknownBasis.totalRealizedPnlSol, null);
assert(unknownBasis.reasons.includes("sale_without_verified_cost_basis"));
const undecoded = parseEvidence({ ...transfer, type: "SWAP" }, WALLET);
assert.equal(undecoded[0].kind, "unpriced", "missing decoded swap cannot become a transfer");
assert.equal(parseEvidence({ ...buy("failed", 5, 1, 1), transactionError: {} }, WALLET).length, 0);
assert.equal(parseEvidence({ ...buy("not-owner", 5, 1, 1), feePayer: OTHER }, OTHER).length, 0);
const multi = buy("two-outs", 6, 1, 1);
multi.events.swap.tokenOutputs.push({ userAccount: WALLET, mint: ALT, rawTokenAmount: quote(1) });
assert(parseEvidence(multi, WALLET).every(e => e.kind === "unpriced"));
const wsol = buy("wsol-input", 7, 1, 1);
delete wsol.events.swap.nativeInput;
wsol.events.swap.tokenInputs = [{ userAccount: WALLET, mint: WSOL,
  rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }];
assert.equal(parseEvidence(wsol, WALLET)[0].kind, "buy");
const noFee = buy("no-fee", 8, 1, 1);
delete noFee.fee;
assert.equal(computePnl([...parseEvidence(noFee, WALLET),
  ...parseEvidence(sell("no-fee-sell", 9, 1, 2), WALLET)], true)[0].totalRealizedPnlSol, null);
assert.equal(computePnl([parseEvidence(buy("only-buy", 10, 1, 1), WALLET)[0]],true)[0].status,"unknown");
const noOrdering = buy("missing-order", 11, 1, 1);
delete noOrdering.slot;
assert.equal(computePnl([...parseEvidence(noOrdering, WALLET),
  ...parseEvidence(sell("after-no-order", 12, 1, 2), WALLET)], true)[0].totalRealizedPnlSol, null);
console.log("[blockchain-forensics-regression] OK: verified swap lots, paid fees, transfer basis, unknown coverage, missed decode, multi-leg safeguards, failed tx");
